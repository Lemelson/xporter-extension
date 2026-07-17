// XPorter — download module
// Owns export serialization and chrome.downloads handoff. The service worker
// only chooses which saved dataset to download.

(function () {
    let activeDownload = null;

    function keepWorkerAliveDuringDownload() {
        if (typeof chrome === 'undefined' || !chrome.runtime?.getPlatformInfo) {
            return () => {};
        }
        // startCurrentDownload acknowledges the popup immediately, so the
        // generation promise is no longer tied to the runtime-message event.
        // Touch a Chrome API before MV3's idle deadline while large parts are
        // being serialized or handed to chrome.downloads.
        const timer = setInterval(() => {
            try {
                chrome.runtime.getPlatformInfo(() => {});
            } catch (_) { /* keepalive is best-effort */ }
        }, 20000);
        return () => clearInterval(timer);
    }

    function getPartLimit(format, mode) {
        const group = mode === 'posts' ? 'posts' : 'users';
        const configured = XPORTER_CONFIG?.DOWNLOAD_PART_LIMITS?.[group]?.[format];
        if (Number.isFinite(configured) && configured > 0) return configured;
        return group === 'posts' ? 10000 : 50000;
    }

    function buildPlan(state, requestedFormat) {
        const format = requestedFormat || state?.outputFormat || 'csv';
        const count = Math.max(0, Number(state?.tweetCount) || 0);
        const partSize = getPartLimit(format, state?.exportMode || 'posts');
        const partCount = Math.max(1, Math.ceil(count / partSize));
        return {
            count,
            format,
            partSize,
            partCount,
            multipart: partCount > 1,
            active: !!activeDownload
        };
    }

    async function getCurrentPlan(format) {
        const state = await XPorterStorage.loadExportState();
        return buildPlan(state, format);
    }

    async function* loadCurrentParts(state, partSize) {
        const readSize = Math.max(1, Number(XPORTER_CONFIG?.STORAGE_BATCH_READ_SIZE) || 100);
        let part = [];

        for (let start = 0; start < (state.totalBatches || 0); start += readSize) {
            const count = Math.min(readSize, state.totalBatches - start);
            const batches = await XPorterStorage.loadTweetBatches(start, count);
            for (const batch of batches) {
                for (const item of batch) {
                    part.push(item);
                    if (part.length === partSize) {
                        yield part;
                        part = [];
                    }
                }
            }
        }

        if (part.length > 0) yield part;
    }

    function reportDownload(message) {
        try {
            const result = chrome.runtime?.sendMessage?.(message);
            result?.catch?.(() => {});
        } catch (_) { /* popup may be closed */ }
    }

    async function recordSuccessfulDownload() {
        await XPorterStorage.recordDownload()
            .then(() => globalThis.XPorterFeedback?.refresh?.())
            .catch(() => {});
    }

    async function downloadCurrent(format) {
        const state = await XPorterStorage.loadExportState();
        const plan = buildPlan(state, format);
        if (!state || plan.count === 0 || !state.totalBatches) return { error: 'NO_DATA' };

        let partNumber = 0;
        let downloadedCount = 0;
        let lastResult = null;
        const filenames = [];
        const exportedAt = new Date();
        for await (const items of loadCurrentParts(state, plan.partSize)) {
            partNumber++;
            reportDownload({
                type: 'DOWNLOAD_PROGRESS',
                partNumber,
                partCount: plan.partCount,
                count: plan.count,
                format: plan.format
            });
            lastResult = await downloadItems(items, {
                username: state.username || 'unknown',
                mode: state.exportMode || 'posts',
                format: plan.format,
                profile: state.userInfo || null,
                dateFrom: state.dateFrom,
                dateTo: state.dateTo,
                exportedAt,
                partNumber,
                partCount: plan.partCount,
                saveAs: !plan.multipart
            });
            if (lastResult?.success !== true) return lastResult;
            downloadedCount += items.length;
            filenames.push(lastResult.filename);
        }

        if (partNumber === 0) return { error: 'NO_DATA' };
        if (downloadedCount !== plan.count) {
            XLog.error(`Download row count mismatch: expected ${plan.count}, read ${downloadedCount}`);
            return { error: 'DOWNLOAD_FAILED' };
        }
        await recordSuccessfulDownload();
        reportDownload({
            type: 'DOWNLOAD_COMPLETE',
            partCount: partNumber,
            count: plan.count,
            format: plan.format
        });
        if (!plan.multipart) return lastResult;
        return { success: true, count: plan.count, partCount: partNumber, filenames };
    }

    async function startCurrentDownload(format) {
        if (activeDownload) return { error: 'DOWNLOAD_IN_PROGRESS' };
        const plan = await getCurrentPlan(format);
        if (plan.count === 0) return { error: 'NO_DATA' };

        const stopKeepAlive = keepWorkerAliveDuringDownload();
        activeDownload = downloadCurrent(plan.format)
            .then(result => {
                if (result?.success !== true) {
                    reportDownload({ type: 'DOWNLOAD_ERROR', error: result?.error || 'DOWNLOAD_FAILED' });
                }
                return result;
            })
            .catch(error => {
                XLog.error('Download failed:', error.message);
                reportDownload({ type: 'DOWNLOAD_ERROR', error: error.message || 'DOWNLOAD_FAILED' });
                return { error: error.message || 'DOWNLOAD_FAILED' };
            })
            .finally(() => {
                stopKeepAlive();
                activeDownload = null;
            });

        return { success: true, started: true, ...plan, active: true };
    }

    async function getCurrentPostsText() {
        const state = await XPorterStorage.loadExportState();
        if (state?.exportMode !== 'posts') return { error: 'NO_DATA' };
        const plan = buildPlan(state, 'txt');
        if (plan.multipart) return { error: 'COPY_TOO_LARGE' };
        for await (const items of loadCurrentParts(state, plan.partSize)) {
            return {
                success: true,
                text: XPorterCSV.generatePostsText(items, state.userInfo || {}),
                count: items.length
            };
        }
        return { error: 'NO_DATA' };
    }

    async function downloadHistory(id, format) {
        const entry = await XPorterStorage.loadExportHistoryEntry(id);
        if (!entry) return { error: 'HISTORY_NOT_FOUND' };
        if (!Array.isArray(entry.items) || entry.items.length === 0) {
            return { error: 'HISTORY_DATA_GONE' };
        }

        const result = await downloadItems(entry.items, {
            username: entry.username || 'unknown',
            mode: entry.exportMode || 'posts',
            format: format || entry.outputFormat || 'csv',
            profile: entry.userInfo || {
                name: entry.displayName || '',
                screenName: entry.username || ''
            },
            dateFrom: entry.dateFrom,
            dateTo: entry.dateTo,
            exportedAt: entry.completedAt || new Date()
        });
        if (result.success) await recordSuccessfulDownload();
        return result;
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

        if (format === 'txt' && mode === 'posts') {
            content = XPorterCSV.generatePostsText(allItems, options.profile || {});
            mimeType = 'text/plain;charset=utf-8;';
            extension = 'txt';
        } else if (format === 'json') {
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
            exportedAt: options.exportedAt || new Date(),
            partNumber: options.partNumber,
            partCount: options.partCount
        });
        const result = await startDownload(content, mimeType, filename, options.saveAs !== false);
        if (result.success) return { ...result, count: allItems.length, filename };
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

    function startDownload(content, mimeType, filename, saveAs = true) {
        const blob = new Blob([content], { type: mimeType });
        const reader = new FileReader();
        return new Promise((resolve) => {
            reader.onerror = () => resolve({ error: 'DOWNLOAD_FAILED' });
            reader.onload = () => {
                chrome.downloads.download({
                    url: reader.result,
                    filename,
                    saveAs
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
        getCurrentPlan,
        startCurrentDownload,
        downloadCurrent,
        getCurrentPostsText,
        downloadHistory,
        downloadSeenPosts
    };
})();
