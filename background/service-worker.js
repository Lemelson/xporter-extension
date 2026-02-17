// XPorter — Background Service Worker
// Orchestrates the export process, handles messages from popup/export page

// Import utility scripts
importScripts(
    '/utils/config.js',
    '/utils/api.js',
    '/utils/rateLimit.js',
    '/utils/csv.js',
    '/utils/storage.js'
);

// Current export state
let currentExport = null;
let rateLimiter = null;

// ==================== Message Handling ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
    });
    return true; // async response
});

async function handleMessage(message, sender) {
    switch (message.type) {
        case 'SET_USERNAME':
            await XPorterStorage.saveDetectedUsername(message.username);
            return { success: true };

        case 'GET_USERNAME':
            const username = await XPorterStorage.loadDetectedUsername();
            return { username };

        case 'START_EXPORT':
            return await startExport(message);

        case 'STOP_EXPORT':
            return stopExport();

        case 'GET_STATUS':
            return await getExportStatus();

        case 'DOWNLOAD_CSV':
        case 'DOWNLOAD_EXPORT':
            return await downloadExport(message.outputFormat);

        case 'RESUME_EXPORT':
            return await resumeExport();

        case 'SAVE_SETTINGS':
            await XPorterStorage.saveSettings(message.settings);
            return { success: true };

        case 'GET_SETTINGS':
            const settings = await XPorterStorage.loadSettings();
            return { settings };

        case 'CLEAR_EXPORT':
            await XPorterStorage.clearExportState();
            currentExport = null;
            return { success: true };

        case 'DISCOVERED_QUERYID':
            // Live queryId captured from X.com's own network traffic
            if (message.queryId && message.operationName) {
                XPorterAPI.setLiveQueryId(message.operationName, message.queryId);
            }
            return { success: true };

        default:
            return { error: 'Unknown message type' };
    }
}

// ==================== Export Engine ====================

async function startExport({ username, dateFrom, dateTo, exportMode, outputFormat }) {
    if (currentExport && currentExport.running) {
        return { error: 'Export already in progress' };
    }

    const settings = await XPorterStorage.loadSettings();
    const mode = exportMode || 'posts';

    // Initialize rate limiter with current settings
    rateLimiter = new RateLimitManager({
        requestDelay: settings.requestDelay,
        batchSize: settings.batchSize,
        cooldownDuration: settings.cooldownDuration
    });

    rateLimiter.onStatusChange((event) => {
        broadcastStatus({ ...event, exportMode: mode });
    });

    // Clear previous export data
    await XPorterStorage.clearExportState();

    currentExport = {
        running: true,
        username: username,
        exportMode: mode,
        outputFormat: outputFormat || 'csv',
        dateFrom: (mode === 'posts' && dateFrom) ? new Date(dateFrom) : null,
        dateTo: (mode === 'posts' && dateTo) ? new Date(dateTo) : null,
        settings: settings,
        tweetCount: 0, // used for both tweets and users (item count)
        totalBatches: 0,
        tweetBuffer: [], // used for both tweets and users
        userId: null,
        cursor: null,
        startedAt: Date.now(),
        status: 'resolving_user'
    };

    // Save initial state
    await saveCurrentState();

    // Start the export process (non-blocking)
    runExportLoop().catch(err => {
        console.error('Export loop error:', err.message);
        if (currentExport) {
            currentExport.running = false;
            currentExport.status = 'error';
            currentExport.error = err.message.startsWith('API_ERROR_400') ? 'STALE_QUERY_ID' : err.message;
            saveCurrentState();
            broadcastStatus({ running: false, status: 'error', error: err.message, exportMode: currentExport.exportMode });
        }
    });

    return { success: true, status: 'started' };
}

async function runExportLoop() {
    try {
        // Step 1: Resolve user ID
        broadcastStatus({ running: true, status: 'resolving_user', username: currentExport.username, exportMode: currentExport.exportMode });

        let userInfo;
        try {
            userInfo = await XPorterAPI.getUserByScreenName(currentExport.username);
        } catch (err) {
            if (err.message === 'NOT_LOGGED_IN') throw new Error('NOT_LOGGED_IN');
            if (err.message === 'USER_NOT_FOUND') throw new Error('USER_NOT_FOUND');
            if (err.message === 'USER_SUSPENDED') throw new Error('USER_SUSPENDED');
            if (err.message.startsWith('ENDPOINT_DISCOVERY_FAILED')) throw new Error('ENDPOINT_DISCOVERY_FAILED');
            throw err;
        }

        if (userInfo.isProtected) {
            throw new Error('ACCOUNT_PRIVATE');
        }

        currentExport.userId = userInfo.id;
        currentExport.userInfo = userInfo;
        currentExport.status = 'fetching';
        await saveCurrentState();

        // Determine expected count based on mode
        const expectedCount = currentExport.exportMode === 'posts'
            ? userInfo.tweetCount
            : (currentExport.exportMode === 'following'
                ? userInfo.followingCount
                : userInfo.followersCount);

        broadcastStatus({
            running: true,
            status: 'fetching',
            username: currentExport.username,
            expectedTweets: expectedCount,
            tweetCount: 0,
            exportMode: currentExport.exportMode
        });

        // Step 2: Run the appropriate fetch loop based on mode
        if (currentExport.exportMode === 'posts') {
            await _fetchPostsLoop();
        } else {
            await _fetchUsersLoop();
        }

        // Save remaining buffer
        if (currentExport.tweetBuffer.length > 0) {
            await XPorterStorage.saveTweetBatch(currentExport.totalBatches, currentExport.tweetBuffer);
            currentExport.totalBatches++;
            currentExport.tweetBuffer = [];
        }

        // Export complete
        currentExport.running = false;
        currentExport.status = 'complete';
        currentExport.completedAt = Date.now();
        await saveCurrentState();

        broadcastStatus({
            running: false,
            status: 'complete',
            tweetCount: currentExport.tweetCount,
            username: currentExport.username,
            exportMode: currentExport.exportMode
        });

    } catch (error) {
        if (error.message === 'ABORTED') {
            // Flush remaining buffer
            if (currentExport.tweetBuffer.length > 0) {
                await XPorterStorage.saveTweetBatch(currentExport.totalBatches, currentExport.tweetBuffer);
                currentExport.totalBatches++;
                currentExport.tweetBuffer = [];
            }
            currentExport.running = false;
            currentExport.status = 'stopped';
            await saveCurrentState();
            broadcastStatus({ running: false, status: 'stopped', tweetCount: currentExport.tweetCount, canResume: true, exportMode: currentExport.exportMode });
        } else {
            throw error;
        }
    }
}

// ==================== Posts Fetch Loop ====================

async function _fetchPostsLoop() {
    let hasMore = true;
    let emptyPages = 0;
    const seenIds = new Set();

    while (hasMore && currentExport.running) {
        // Check quantity limit
        if (currentExport.settings.quantityLimit > 0 &&
            currentExport.tweetCount >= currentExport.settings.quantityLimit) {
            break;
        }

        const result = await rateLimiter.executeWithRateLimit(async () => {
            return await XPorterAPI.fetchUserTweets(
                currentExport.userId,
                currentExport.cursor
            );
        });

        if (!result.tweets || result.tweets.length === 0) {
            emptyPages++;
            if (emptyPages >= 3) {
                hasMore = false;
                break;
            }
        } else {
            emptyPages = 0;
        }

        // Process tweets
        for (const tweet of (result.tweets || [])) {
            if (!currentExport.settings.includeRetweets && tweet.type === 'retweet') continue;
            if (!currentExport.settings.includeReplies && tweet.type === 'reply') continue;

            // Date filtering
            if (tweet.created_at) {
                const tweetDate = new Date(tweet.created_at);
                if (currentExport.dateTo && tweetDate > currentExport.dateTo) continue;
                if (currentExport.dateFrom && tweetDate < currentExport.dateFrom) {
                    hasMore = false;
                    break;
                }
            }

            if (seenIds.has(tweet.id)) continue;
            seenIds.add(tweet.id);

            // Inject author info if missing
            if (!tweet.author_name && currentExport.userInfo) {
                tweet.author_name = currentExport.userInfo.name || '';
                tweet.author_username = currentExport.userInfo.screenName || currentExport.username || '';
                if (tweet.tweet_url && tweet.tweet_url.includes('/undefined/')) {
                    tweet.tweet_url = tweet.tweet_url.replace('/undefined/', `/${tweet.author_username}/`);
                }
            }

            currentExport.tweetBuffer.push(tweet);
            currentExport.tweetCount++;

            if (currentExport.tweetBuffer.length >= XPorterStorage.MAX_TWEETS_PER_BATCH) {
                await XPorterStorage.saveTweetBatch(currentExport.totalBatches, currentExport.tweetBuffer);
                currentExport.totalBatches++;
                currentExport.tweetBuffer = [];
            }
        }

        // Update cursor
        if (result.nextCursor) {
            currentExport.cursor = result.nextCursor;
        } else {
            hasMore = false;
        }

        await saveCurrentState();

        broadcastStatus({
            running: true,
            status: 'fetching',
            username: currentExport.username,
            tweetCount: currentExport.tweetCount,
            expectedTweets: currentExport.userInfo?.tweetCount || 0,
            quantityLimit: currentExport.settings?.quantityLimit || 0,
            batch: Math.floor(rateLimiter.totalRequests / rateLimiter.batchSize) + 1,
            totalRequests: rateLimiter.totalRequests,
            exportMode: currentExport.exportMode
        });
    }
}

// ==================== Users (Followers/Following) Fetch Loop ====================

async function _fetchUsersLoop() {
    let hasMore = true;
    let emptyPages = 0;
    const seenIds = new Set();

    // Pick the right API function
    const fetchFn = {
        followers: XPorterAPI.fetchFollowers,
        following: XPorterAPI.fetchFollowing,
        verified_followers: XPorterAPI.fetchVerifiedFollowers
    }[currentExport.exportMode];

    if (!fetchFn) {
        throw new Error('Unknown export mode: ' + currentExport.exportMode);
    }

    while (hasMore && currentExport.running) {
        // Check quantity limit
        if (currentExport.settings.quantityLimit > 0 &&
            currentExport.tweetCount >= currentExport.settings.quantityLimit) {
            break;
        }

        const result = await rateLimiter.executeWithRateLimit(async () => {
            return await fetchFn(
                currentExport.userId,
                currentExport.cursor
            );
        });

        if (!result.users || result.users.length === 0) {
            emptyPages++;
            if (emptyPages >= 3) {
                hasMore = false;
                break;
            }
        } else {
            emptyPages = 0;
        }

        // Process users
        for (const user of (result.users || [])) {
            if (seenIds.has(user.id)) continue;
            seenIds.add(user.id);

            currentExport.tweetBuffer.push(user);
            currentExport.tweetCount++;

            if (currentExport.tweetBuffer.length >= XPorterStorage.MAX_TWEETS_PER_BATCH) {
                await XPorterStorage.saveTweetBatch(currentExport.totalBatches, currentExport.tweetBuffer);
                currentExport.totalBatches++;
                currentExport.tweetBuffer = [];
            }
        }

        // Update cursor
        if (result.nextCursor) {
            currentExport.cursor = result.nextCursor;
        } else {
            hasMore = false;
        }

        await saveCurrentState();

        const expectedCount = currentExport.exportMode === 'following'
            ? (currentExport.userInfo?.followingCount || 0)
            : (currentExport.userInfo?.followersCount || 0);

        broadcastStatus({
            running: true,
            status: 'fetching',
            username: currentExport.username,
            tweetCount: currentExport.tweetCount,
            expectedTweets: expectedCount,
            quantityLimit: currentExport.settings?.quantityLimit || 0,
            batch: Math.floor(rateLimiter.totalRequests / rateLimiter.batchSize) + 1,
            totalRequests: rateLimiter.totalRequests,
            exportMode: currentExport.exportMode
        });
    }
}

// ==================== Stop / Resume / Status ====================

async function stopExport() {
    if (currentExport) {
        currentExport.running = false;
        if (currentExport.tweetBuffer && currentExport.tweetBuffer.length > 0) {
            await XPorterStorage.saveTweetBatch(currentExport.totalBatches, currentExport.tweetBuffer);
            currentExport.totalBatches++;
            currentExport.tweetBuffer = [];
            currentExport.status = 'stopped';
            await saveCurrentState();
        }
    }
    if (rateLimiter) {
        rateLimiter.abort();
    }
    return { success: true };
}

async function resumeExport() {
    const savedState = await XPorterStorage.loadExportState();
    if (!savedState) {
        return { error: 'No export to resume' };
    }

    const settings = await XPorterStorage.loadSettings();

    rateLimiter = new RateLimitManager({
        requestDelay: settings.requestDelay,
        batchSize: settings.batchSize,
        cooldownDuration: settings.cooldownDuration
    });

    rateLimiter.onStatusChange((event) => {
        broadcastStatus({ ...event, exportMode: savedState.exportMode });
    });

    currentExport = {
        running: true,
        username: savedState.username,
        exportMode: savedState.exportMode || 'posts',
        outputFormat: savedState.outputFormat || 'csv',
        dateFrom: savedState.dateFrom ? new Date(savedState.dateFrom) : null,
        dateTo: savedState.dateTo ? new Date(savedState.dateTo) : null,
        settings: settings,
        tweetCount: savedState.tweetCount || 0,
        totalBatches: savedState.totalBatches || 0,
        tweetBuffer: [],
        userId: savedState.userId,
        userInfo: savedState.userInfo,
        cursor: savedState.cursor,
        startedAt: savedState.startedAt,
        status: 'fetching'
    };

    runExportLoop().catch(err => {
        console.error('Resume export error:', err);
        if (currentExport) {
            currentExport.running = false;
            currentExport.status = 'error';
            currentExport.error = err.message;
            saveCurrentState();
            broadcastStatus({ running: false, status: 'error', error: err.message, exportMode: currentExport.exportMode });
        }
    });

    return { success: true, status: 'resumed', tweetCount: currentExport.tweetCount };
}

async function getExportStatus() {
    if (currentExport) {
        return {
            running: currentExport.running,
            status: currentExport.status,
            username: currentExport.username,
            tweetCount: currentExport.tweetCount,
            expectedTweets: currentExport.userInfo?.tweetCount || 0,
            quantityLimit: currentExport.settings?.quantityLimit || 0,
            error: currentExport.error || null,
            startedAt: currentExport.startedAt,
            completedAt: currentExport.completedAt,
            userInfo: currentExport.userInfo,
            exportMode: currentExport.exportMode,
            outputFormat: currentExport.outputFormat,
            canResume: !currentExport.running && (currentExport.status === 'stopped' || currentExport.status === 'error')
        };
    }

    // Check saved state
    const savedState = await XPorterStorage.loadExportState();
    if (savedState) {
        const savedSettings = await XPorterStorage.loadSettings();
        if (savedSettings.autoExpireEnabled && savedState.updatedAt) {
            const maxAge = (savedSettings.autoExpireHours || 4) * 60 * 60 * 1000;
            if (Date.now() - savedState.updatedAt > maxAge) {
                await XPorterStorage.clearExportState();
                return { running: false, status: 'idle' };
            }
        }

        return {
            running: false,
            status: savedState.status,
            username: savedState.username,
            tweetCount: savedState.tweetCount || 0,
            expectedTweets: savedState.userInfo?.tweetCount || 0,
            quantityLimit: savedSettings?.quantityLimit || 0,
            error: savedState.error || null,
            startedAt: savedState.startedAt,
            completedAt: savedState.completedAt,
            userInfo: savedState.userInfo,
            exportMode: savedState.exportMode,
            outputFormat: savedState.outputFormat,
            canResume: savedState.status === 'stopped' || savedState.status === 'error'
        };
    }

    return { running: false, status: 'idle' };
}

// ==================== Download (Multi-Format) ====================

async function downloadExport(format) {
    const allItems = await XPorterStorage.loadAllTweets();
    if (allItems.length === 0) {
        return { error: 'No data to download' };
    }

    const state = await XPorterStorage.loadExportState();
    const username = state?.username || 'unknown';
    const mode = state?.exportMode || 'posts';
    format = format || state?.outputFormat || 'csv';

    // Determine headers based on mode
    const isUsers = (mode !== 'posts');

    let content, mimeType, extension;

    if (format === 'json') {
        content = JSON.stringify(allItems, null, 2);
        mimeType = 'application/json;charset=utf-8;';
        extension = 'json';
    } else if (format === 'xlsx') {
        content = generateSimpleXLSX(allItems, isUsers);
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        extension = 'xlsx';
    } else {
        // CSV (default)
        if (isUsers) {
            content = generateUsersCSV(allItems);
        } else {
            content = XPorterCSV.generateCSV(allItems);
        }
        mimeType = 'text/csv;charset=utf-8;';
        extension = 'csv';
    }

    const filename = generateExportFilename(username, mode, extension);
    const blob = new Blob([content], { type: mimeType });
    const reader = new FileReader();

    return new Promise((resolve) => {
        reader.onload = () => {
            chrome.downloads.download({
                url: reader.result,
                filename: filename,
                saveAs: true
            }, (downloadId) => {
                resolve({ success: true, downloadId, count: allItems.length, filename });
            });
        };
        reader.readAsDataURL(blob);
    });
}

/**
 * Generate CSV for user data (followers/following)
 */
function generateUsersCSV(users) {
    const headers = [
        'id', 'name', 'username', 'bio', 'location', 'url',
        'followers_count', 'following_count', 'tweet_count', 'listed_count',
        'verified', 'protected', 'created_at', 'profile_image_url', 'profile_url'
    ];

    let csv = headers.join(',') + '\n';

    for (const user of users) {
        const row = headers.map(h => {
            let val = user[h] ?? '';
            val = String(val);
            if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
                val = '"' + val.replace(/"/g, '""') + '"';
            }
            return val;
        });
        csv += row.join(',') + '\n';
    }

    return '\uFEFF' + csv; // BOM for Excel
}

/**
 * Generate a simple XLSX file (XML-based SpreadsheetML) — no external deps
 */
function generateSimpleXLSX(items, isUsers) {
    const headers = isUsers
        ? ['id', 'name', 'username', 'bio', 'location', 'url', 'followers_count', 'following_count', 'tweet_count', 'listed_count', 'verified', 'protected', 'created_at', 'profile_image_url', 'profile_url']
        : ['id', 'text', 'tweet_url', 'language', 'type', 'author_name', 'author_username', 'view_count', 'bookmark_count', 'favorite_count', 'retweet_count', 'reply_count', 'quote_count', 'created_at', 'source', 'hashtags', 'urls', 'media_type', 'media_urls'];

    // Generate XML Spreadsheet (compatible with Excel, LibreOffice, Google Sheets)
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<?mso-application progid="Excel.Sheet"?>\n';
    xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n';
    xml += ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
    xml += '<Worksheet ss:Name="Export">\n<Table>\n';

    // Header row
    xml += '<Row>';
    for (const h of headers) {
        xml += `<Cell><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`;
    }
    xml += '</Row>\n';

    // Data rows
    for (const item of items) {
        xml += '<Row>';
        for (const h of headers) {
            const val = String(item[h] ?? '');
            const isNum = !isNaN(val) && val !== '' && !val.includes(' ');
            xml += `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${escapeXml(val)}</Data></Cell>`;
        }
        xml += '</Row>\n';
    }

    xml += '</Table>\n</Worksheet>\n</Workbook>';
    return xml;
}

function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Generate filename: XPorter_{username}_{mode}_{timestamp}.{ext}
 */
function generateExportFilename(username, mode, ext) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        '_',
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds())
    ].join('');

    const modeLabel = mode === 'posts' ? 'posts'
        : mode === 'followers' ? 'followers'
            : mode === 'following' ? 'following'
                : mode === 'verified_followers' ? 'verified_followers'
                    : mode;

    return `XPorter_${username}_${modeLabel}_${timestamp}.${ext}`;
}

// ==================== Helpers ====================

async function saveCurrentState() {
    if (!currentExport) return;

    await XPorterStorage.saveExportState({
        username: currentExport.username,
        userId: currentExport.userId,
        userInfo: currentExport.userInfo,
        cursor: currentExport.cursor,
        tweetCount: currentExport.tweetCount,
        totalBatches: currentExport.totalBatches,
        dateFrom: currentExport.dateFrom?.toISOString() || null,
        dateTo: currentExport.dateTo?.toISOString() || null,
        exportMode: currentExport.exportMode,
        outputFormat: currentExport.outputFormat,
        status: currentExport.status,
        error: currentExport.error,
        startedAt: currentExport.startedAt,
        completedAt: currentExport.completedAt,
        running: currentExport.running,
        rateLimiterState: rateLimiter?.getState() || null
    });
}

function broadcastStatus(event) {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({
        type: 'EXPORT_STATUS_UPDATE',
        ...event
    }).catch(() => {
        // No listeners — that's fine
    });
}

// ==================== Auto-Resume on Startup ====================

chrome.runtime.onStartup.addListener(async () => {
    const state = await XPorterStorage.loadExportState();
    if (state && state.running) {
        console.log('XPorter: Resuming interrupted export...');
        state.running = false;
        state.status = 'stopped';
        await XPorterStorage.saveExportState(state);
    }
});

// Also check on install/update
chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
        await XPorterStorage.saveSettings({
            includeRetweets: true,
            includeReplies: true,
            quantityLimit: 500,
            requestDelay: 3000,
            batchSize: 20,
            cooldownDuration: 180000,
            theme: 'dark',
            exportMode: 'posts',
            outputFormat: 'csv'
        });
    }
});
