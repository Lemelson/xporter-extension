// XPorter — Background Service Worker
// Orchestrates the export process, handles messages from popup/export page

// Import utility scripts (paths relative to this service worker's location)
importScripts(
    '../utils/config.js',
    '../utils/api-features.js',
    '../utils/api.js',
    '../utils/rateLimit.js',
    '../utils/csv.js',
    '../utils/storage.js'
);

// Current export state
let currentExport = null;
let rateLimiter = null;
let searchCapture = null;

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

        case 'DOWNLOAD_HISTORY_ENTRY':
            return await downloadHistoryEntry(message.id, message.outputFormat);

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

        case 'PAGE_GRAPHQL_RESPONSE':
            return handlePageGraphqlResponse(message, sender);

        case 'GET_EXPORT_HISTORY':
            const history = await XPorterStorage.loadExportHistory();
            return { history: history.map(({ items, ...entry }) => entry) };

        case 'DELETE_HISTORY_ENTRY':
            await XPorterStorage.deleteExportHistoryEntry(message.id);
            return { success: true };

        case 'CLEAR_HISTORY':
            await XPorterStorage.clearExportHistory();
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
    const normalizedDateFrom = (mode === 'posts') ? normalizeDateBoundary(dateFrom, 'start') : null;
    const normalizedDateTo = (mode === 'posts') ? normalizeDateBoundary(dateTo, 'end') : null;

    if (normalizedDateFrom && normalizedDateTo && normalizedDateFrom > normalizedDateTo) {
        return { error: 'INVALID_DATE_RANGE' };
    }

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
        dateFrom: normalizedDateFrom,
        dateTo: normalizedDateTo,
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
        XLog.error('Export loop error:', err.message);
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

        // Save to export history
        const ui = currentExport.userInfo || {};
        const historyItems = await XPorterStorage.loadAllTweets();
        await XPorterStorage.saveExportHistory({
            username: ui.screenName || currentExport.username,
            displayName: ui.name || currentExport.username,
            profileImageUrl: ui.profileImageUrl || '',
            exportMode: currentExport.exportMode,
            itemCount: currentExport.tweetCount,
            outputFormat: currentExport.outputFormat || 'csv',
            dateFrom: currentExport.dateFrom?.toISOString() || null,
            dateTo: currentExport.dateTo?.toISOString() || null,
            completedAt: Date.now(),
            items: historyItems
        });

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
    if (currentExport.dateFrom || currentExport.dateTo) {
        await _fetchPostsByDateRangeLoop();
        return;
    }

    let hasMore = true;
    let emptyPages = 0;
    const seenIds = new Set();

    while (hasMore && currentExport.running) {
        // Check quantity limit
        if (currentExport.settings.quantityLimit > 0 &&
            currentExport.tweetCount >= currentExport.settings.quantityLimit) {
            break;
        }

        const requestCursor = currentExport.cursor;
        const result = await rateLimiter.executeWithRateLimit(async () => {
            return await XPorterAPI.fetchUserTweets(
                currentExport.userId,
                requestCursor
            );
        });

        if (!result.tweets || result.tweets.length === 0) {
            const cursorAdvanced = !!result.nextCursor && result.nextCursor !== requestCursor;
            emptyPages = cursorAdvanced ? 0 : (emptyPages + 1);
            if (emptyPages >= 3) {
                hasMore = false;
                break;
            }
        } else {
            emptyPages = 0;
        }

        // Track newest non-pinned tweet date in this batch for pagination decision.
        // Using "newest" (not "oldest") makes us robust against out-of-order old items
        // such as reply-context tweets embedded in profile-conversation threads.
        let newestNonPinnedDate = null;

        // Process tweets
        for (const tweet of (result.tweets || [])) {
            if (!currentExport.settings.includeRetweets && tweet.type === 'retweet') continue;
            if (!currentExport.settings.includeReplies && tweet.type === 'reply') continue;

            // Date filtering
            let tweetDate = null;
            if (tweet.created_at) {
                tweetDate = new Date(tweet.created_at);
                if (!isNaN(tweetDate.getTime()) && !tweet.is_pinned) {
                    if (!newestNonPinnedDate || tweetDate > newestNonPinnedDate) {
                        newestNonPinnedDate = tweetDate;
                    }
                }
                if (currentExport.dateTo && tweetDate > currentExport.dateTo) continue;
                if (currentExport.dateFrom && tweetDate < currentExport.dateFrom) continue;
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

        // Stop paginating when even the newest eligible tweet in this batch is
        // already older than dateFrom — the timeline has clearly scrolled past
        // the window. This avoids false positives from isolated old items
        // (pinned tweets, reply-context in conversation threads) while still
        // guaranteeing termination once we reach the pre-window era.
        if (currentExport.dateFrom && newestNonPinnedDate && newestNonPinnedDate < currentExport.dateFrom) {
            hasMore = false;
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

function normalizeDateBoundary(dateValue, boundary) {
    if (!dateValue) return null;

    const normalized = new Date(`${dateValue}T00:00:00.000Z`);
    if (isNaN(normalized.getTime())) return null;

    if (boundary === 'end') {
        normalized.setUTCHours(23, 59, 59, 999);
    }

    return normalized;
}

async function _fetchPostsByDateRangeLoop() {
    let hasMore = true;
    let emptyPages = 0;
    const seenIds = new Set();
    const rawQuery = buildDateRangeSearchQuery(currentExport.username, currentExport.dateFrom, currentExport.dateTo);
    let payload = null;

    await openSearchCaptureTab(rawQuery);

    try {
        payload = await waitForSearchCapturePayload(20000);
        if (!payload) {
            throw new Error('SEARCH_CAPTURE_TIMEOUT');
        }
        await sendSearchCaptureStatus({ phase: `Exporting @${currentExport.username}...` });

        while (hasMore && currentExport.running) {
            if (currentExport.settings.quantityLimit > 0 &&
                currentExport.tweetCount >= currentExport.settings.quantityLimit) {
                break;
            }

            const parsedPayload = parseSearchTimelineResponse(JSON.parse(payload.bodyText));

            if (!parsedPayload.tweets || parsedPayload.tweets.length === 0) {
                emptyPages++;
                if (emptyPages >= 3) {
                    hasMore = false;
                    break;
                }
            } else {
                emptyPages = 0;
            }

            for (const tweet of (parsedPayload.tweets || [])) {
                if (!currentExport.settings.includeRetweets && tweet.type === 'retweet') continue;
                if (!currentExport.settings.includeReplies && tweet.type === 'reply') continue;
                if (seenIds.has(tweet.id)) continue;
                seenIds.add(tweet.id);

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

            if (parsedPayload.nextCursor) {
                currentExport.cursor = parsedPayload.nextCursor;
                await sendSearchCaptureStatus({ phase: `Scrolling X search for @${currentExport.username}...` });
                payload = await requestNextSearchCapturePayload();
                if (!payload) {
                    hasMore = false;
                }
            } else {
                hasMore = false;
            }

            await saveCurrentState();
            await sendSearchCaptureStatus({ phase: `Exporting @${currentExport.username}...` });

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
    } finally {
        await closeSearchCaptureTab();
    }
}

function buildDateRangeSearchQuery(username, dateFrom, dateTo) {
    const parts = [`(from:${username})`];

    if (dateFrom) {
        parts.push(`since:${formatDateForSearch(dateFrom)}`);
    }

    if (dateTo) {
        const dayAfter = new Date(dateTo.getTime());
        dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
        parts.push(`until:${formatDateForSearch(dayAfter)}`);
    }

    return parts.join(' ');
}

function formatDateForSearch(date) {
    return date.toISOString().slice(0, 10);
}

function buildSearchTimelinePageUrl(rawQuery) {
    return `https://x.com/search?q=${encodeURIComponent(rawQuery)}&src=typed_query&f=live`;
}

async function openSearchCaptureTab(rawQuery) {
    await closeSearchCaptureTab();

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);

    // X search lazy-loads reliably only in a foreground tab.
    const tab = await chrome.tabs.create({
        url: buildSearchTimelinePageUrl(rawQuery),
        active: true
    });

    searchCapture = {
        tabId: tab.id,
        returnTabId: activeTab?.id || null,
        queue: [],
        resolver: null,
        seenUrls: new Set()
    };

    setTimeout(() => {
        sendSearchCaptureStatus({ phase: `Preparing search for @${currentExport?.username || 'profile'}...` }, 8);
    }, 1000);
}

async function closeSearchCaptureTab() {
    if (!searchCapture) return;

    const { tabId, returnTabId, resolver } = searchCapture;
    searchCapture = null;

    if (resolver) {
        resolver(null);
    }

    if (typeof tabId === 'number') {
        try {
            await chrome.tabs.remove(tabId);
        } catch (_) {
            // Tab may already be closed
        }
    }

    if (typeof returnTabId === 'number') {
        try {
            await chrome.tabs.update(returnTabId, { active: true });
        } catch (_) {
            // Original tab may already be closed
        }
    }
}

function waitForSearchCapturePayload(timeoutMs = 10000) {
    if (!searchCapture) return Promise.resolve(null);
    if (searchCapture.queue.length > 0) {
        return Promise.resolve(searchCapture.queue.shift());
    }

    return new Promise((resolve) => {
        const activeCapture = searchCapture;
        const timer = setTimeout(() => {
            if (activeCapture && activeCapture.resolver === resolver) {
                activeCapture.resolver = null;
            }
            resolve(null);
        }, timeoutMs);

        const resolver = (payload) => {
            clearTimeout(timer);
            resolve(payload);
        };

        activeCapture.resolver = resolver;
    });
}

async function requestNextSearchCapturePayload() {
    if (!searchCapture?.tabId) return null;

    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            await chrome.tabs.sendMessage(searchCapture.tabId, { type: 'XPORTER_SCROLL_SEARCH_PAGE' });
        } catch (_) {
            // Tab may still be loading; wait for the payload timeout instead
        }

        const payload = await waitForSearchCapturePayload(8000);
        if (payload) {
            return payload;
        }
    }

    return null;
}

async function sendSearchCaptureStatus(overrides = {}, attempts = 1) {
    if (!searchCapture?.tabId || !currentExport) return false;

    const message = {
        type: 'XPORTER_SEARCH_CAPTURE_STATUS',
        username: currentExport.username,
        tweetCount: currentExport.tweetCount || 0,
        quantityLimit: currentExport.settings?.quantityLimit || 0,
        dateFrom: currentExport.dateFrom ? formatDateForSearch(currentExport.dateFrom) : '',
        dateTo: currentExport.dateTo ? formatDateForSearch(currentExport.dateTo) : '',
        ...overrides
    };

    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            await chrome.tabs.sendMessage(searchCapture.tabId, message);
            return true;
        } catch (_) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    return false;
}

function handlePageGraphqlResponse(message, sender) {
    const senderTabId = sender?.tab?.id;
    if (!searchCapture || senderTabId !== searchCapture.tabId) {
        return { ignored: true };
    }

    if (message.operationName !== 'SearchTimeline' || !message.bodyText || !message.url) {
        return { ignored: true };
    }

    if (searchCapture.seenUrls.has(message.url)) {
        return { duplicate: true };
    }
    searchCapture.seenUrls.add(message.url);

    const payload = {
        url: message.url,
        bodyText: message.bodyText,
        status: message.status || 200
    };

    if (searchCapture.resolver) {
        const resolver = searchCapture.resolver;
        searchCapture.resolver = null;
        resolver(payload);
    } else {
        searchCapture.queue.push(payload);
    }

    return { success: true };
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
    await closeSearchCaptureTab();
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
        XLog.error('Resume export error:', err);
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

    return await downloadItems(allItems, {
        username,
        mode,
        format,
        dateFrom: state?.dateFrom,
        dateTo: state?.dateTo
    });
}

async function downloadHistoryEntry(id, format) {
    const entry = await XPorterStorage.loadExportHistoryEntry(id);
    if (!entry) {
        return { error: 'History entry not found' };
    }
    if (!Array.isArray(entry.items) || entry.items.length === 0) {
        return { error: 'Export data is no longer available for this history entry' };
    }

    return await downloadItems(entry.items, {
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
    const isUsers = (mode !== 'posts');
    let content, mimeType, extension;

    if (format === 'json') {
        content = JSON.stringify(allItems, null, 2);
        mimeType = 'application/json;charset=utf-8;';
        extension = 'json';
    } else if (format === 'xlsx') {
        content = XPorterCSV.generateSimpleXLSX(allItems, isUsers);
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        extension = 'xlsx';
    } else {
        content = XPorterCSV.generateCSV(allItems, isUsers);
        mimeType = 'text/csv;charset=utf-8;';
        extension = 'csv';
    }

    const filename = XPorterCSV.generateExportFilename(username, mode, extension, {
        dateFrom: options.dateFrom,
        dateTo: options.dateTo,
        exportedAt: options.exportedAt || new Date()
    });
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
        XLog.log('Resuming interrupted export...');
        state.running = false;
        state.status = 'stopped';
        await XPorterStorage.saveExportState(state);
    }

    // Pre-discover endpoints in background so first export is fast
    try {
        await XPorterAPI.discoverEndpoints();
        XLog.log('Endpoints pre-discovered on startup');
    } catch (e) {
        XLog.warn('Pre-discovery on startup failed (will retry on export):', e.message);
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

    // Pre-discover endpoints on install/update
    try {
        await XPorterAPI.discoverEndpoints();
        XLog.log('Endpoints pre-discovered on install/update');
    } catch (e) {
        XLog.warn('Pre-discovery on install failed:', e.message);
    }
});
