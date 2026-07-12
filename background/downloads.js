// XPorter — download module
// Owns export serialization and chrome.downloads handoff. The service worker
// only chooses which saved dataset to download.

(function () {
    async function downloadCurrent(format) {
        const allItems = await XPorterStorage.loadAllTweets();
        if (allItems.length === 0) return { error: 'NO_DATA' };

        const state = await XPorterStorage.loadExportState();
        return downloadItems(allItems, {
            username: state?.username || 'unknown',
            mode: state?.exportMode || 'posts',
            format: format || state?.outputFormat || 'csv',
            dateFrom: state?.dateFrom,
            dateTo: state?.dateTo
        });
    }

    async function downloadHistory(id, format) {
        const entry = await XPorterStorage.loadExportHistoryEntry(id);
        if (!entry) return { error: 'HISTORY_NOT_FOUND' };
        if (!Array.isArray(entry.items) || entry.items.length === 0) {
            return { error: 'HISTORY_DATA_GONE' };
        }

        return downloadItems(entry.items, {
            username: entry.username || 'unknown',
            mode: entry.exportMode || 'posts',
            format: format || entry.outputFormat || 'csv',
            dateFrom: entry.dateFrom,
            dateTo: entry.dateTo,
            exportedAt: entry.completedAt || new Date()
        });
    }

    async function downloadItems(allItems, options) {
        const username = options.username || 'unknown';
        const mode = options.mode || 'posts';
        const format = options.format || 'csv';
        const isUsers = mode !== 'posts';
        let content;
        let mimeType;
        let extension;

        const settings = await XPorterStorage.loadSettings();
        const headerOpts = {
            localize: settings.localizeExportHeaders === true,
            lang: settings.language || 'en'
        };

        if (format === 'json') {
            content = JSON.stringify(allItems, null, 2);
            mimeType = 'application/json;charset=utf-8;';
            extension = 'json';
        } else if (format === 'xlsx') {
            content = XPorterCSV.generateXLSX(allItems, isUsers, headerOpts);
            mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            extension = 'xlsx';
        } else {
            content = XPorterCSV.generateCSV(allItems, isUsers, headerOpts);
            mimeType = 'text/csv;charset=utf-8;';
            extension = 'csv';
        }

        const filename = XPorterCSV.generateExportFilename(username, mode, extension, {
            dateFrom: options.dateFrom,
            dateTo: options.dateTo,
            exportedAt: options.exportedAt || new Date()
        });
        const result = await startDownload(content, mimeType, filename);
        if (result.success) {
            XPorterStorage.recordDownload()
                .then(() => globalThis.XPorterFeedback?.refresh?.())
                .catch(() => {});
            return { ...result, count: allItems.length, filename };
        }
        return result;
    }

    const FEED_EXPORT_HEADERS = [
        'id', 'text', 'tweet_url', 'language', 'created_at',
        'author_id', 'author_name', 'author_username',
        'author_followers_count', 'first_author_followers_count', 'author_verified',
        'view_count', 'bookmark_count', 'favorite_count', 'retweet_count', 'reply_count', 'quote_count',
        'first_view_count', 'first_bookmark_count', 'first_favorite_count',
        'first_retweet_count', 'first_reply_count', 'first_quote_count',
        'first_seen_at', 'last_seen_at', 'seen_count', 'last_surface',
        'is_quote', 'is_retweet', 'media_count', 'media_types'
    ];

    async function downloadSeenPosts(outputFormat) {
        const posts = await XPorterPostDB.getAllPosts();
        if (posts.length === 0) return { error: 'NO_DATA' };

        const rows = posts.map(post => ({
            ...post,
            first_seen_at: post.first_seen_at ? new Date(post.first_seen_at).toISOString() : '',
            last_seen_at: post.last_seen_at ? new Date(post.last_seen_at).toISOString() : ''
        }));
        const format = outputFormat === 'json' ? 'json' : 'csv';
        let content;
        let mimeType;

        if (format === 'json') {
            content = JSON.stringify(rows.map(({ created_at_ms, ...post }) => post), null, 2);
            mimeType = 'application/json;charset=utf-8;';
        } else {
            const lines = [FEED_EXPORT_HEADERS.map(XPorterCSV.escapeCSVValue).join(',')];
            for (const row of rows) {
                lines.push(FEED_EXPORT_HEADERS.map(header => XPorterCSV.escapeCSVValue(row[header])).join(','));
            }
            content = '\uFEFF' + lines.join('\n') + '\n';
            mimeType = 'text/csv;charset=utf-8;';
        }

        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const filename = `XPorter_seen_posts_${stamp}.${format}`;
        const result = await startDownload(content, mimeType, filename);
        return result.success ? { ...result, count: rows.length, filename } : result;
    }

    function startDownload(content, mimeType, filename) {
        const blob = new Blob([content], { type: mimeType });
        const reader = new FileReader();
        return new Promise((resolve) => {
            reader.onerror = () => resolve({ error: 'DOWNLOAD_FAILED' });
            reader.onload = () => {
                chrome.downloads.download({
                    url: reader.result,
                    filename,
                    saveAs: true
                }, (downloadId) => {
                    if (chrome.runtime.lastError || downloadId === undefined) {
                        XLog.error('Download failed:', chrome.runtime.lastError?.message);
                        resolve({ error: 'DOWNLOAD_FAILED' });
                        return;
                    }
                    resolve({ success: true, downloadId });
                });
            };
            reader.readAsDataURL(blob);
        });
    }

    globalThis.XPorterDownloads = {
        downloadCurrent,
        downloadHistory,
        downloadSeenPosts
    };
})();
