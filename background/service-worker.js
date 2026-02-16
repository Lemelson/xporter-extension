// XPorter — Background Service Worker
// Orchestrates the export process, handles messages from popup/export page

// Import utility scripts
importScripts(
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
            return await downloadCSV();

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

        default:
            return { error: 'Unknown message type' };
    }
}

// ==================== Export Engine ====================

async function startExport({ username, dateFrom, dateTo }) {
    if (currentExport && currentExport.running) {
        return { error: 'Export already in progress' };
    }

    const settings = await XPorterStorage.loadSettings();

    // Initialize rate limiter with current settings
    rateLimiter = new RateLimitManager({
        requestDelay: settings.requestDelay,
        batchSize: settings.batchSize,
        cooldownDuration: settings.cooldownDuration
    });

    rateLimiter.onStatusChange((event) => {
        broadcastStatus(event);
    });

    // Clear previous export data
    await XPorterStorage.clearExportState();

    currentExport = {
        running: true,
        username: username,
        dateFrom: dateFrom ? new Date(dateFrom) : null,
        dateTo: dateTo ? new Date(dateTo) : null,
        settings: settings,
        tweetCount: 0,
        totalBatches: 0,
        tweetBuffer: [],
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
            // Clean up error message for user display
            currentExport.error = err.message.startsWith('API_ERROR_400') ? 'STALE_QUERY_ID' : err.message;
            saveCurrentState();
            broadcastStatus({ running: false, status: 'error', error: err.message });
        }
    });

    return { success: true, status: 'started' };
}

async function runExportLoop() {
    try {
        // Step 1: Resolve user ID
        broadcastStatus({ running: true, status: 'resolving_user', username: currentExport.username });

        let userInfo;
        try {
            userInfo = await XPorterAPI.getUserByScreenName(currentExport.username);
        } catch (err) {
            if (err.message === 'NOT_LOGGED_IN') {
                throw new Error('NOT_LOGGED_IN');
            }
            if (err.message === 'USER_NOT_FOUND') {
                throw new Error('USER_NOT_FOUND');
            }
            if (err.message === 'USER_SUSPENDED') {
                throw new Error('USER_SUSPENDED');
            }
            if (err.message.startsWith('ENDPOINT_DISCOVERY_FAILED')) {
                throw new Error('ENDPOINT_DISCOVERY_FAILED');
            }
            throw err;
        }

        if (userInfo.isProtected) {
            throw new Error('ACCOUNT_PRIVATE');
        }

        currentExport.userId = userInfo.id;
        currentExport.userInfo = userInfo;
        currentExport.status = 'fetching';
        await saveCurrentState();

        broadcastStatus({
            running: true,
            status: 'fetching',
            username: currentExport.username,
            expectedTweets: userInfo.tweetCount,
            tweetCount: 0
        });

        // Step 2: Fetch tweets in a loop
        let hasMore = true;
        let emptyPages = 0;
        const seenIds = new Set(); // Deduplicate pinned tweets that appear on every page

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
                // Apply filters
                if (!currentExport.settings.includeRetweets && tweet.type === 'retweet') continue;
                if (!currentExport.settings.includeReplies && tweet.type === 'reply') continue;

                // Date filtering
                if (tweet.created_at) {
                    const tweetDate = new Date(tweet.created_at);

                    if (currentExport.dateTo && tweetDate > currentExport.dateTo) continue;
                    if (currentExport.dateFrom && tweetDate < currentExport.dateFrom) {
                        // Tweets are in reverse chronological order
                        // If we've gone past the start date, we're done
                        hasMore = false;
                        break;
                    }
                }

                // Skip duplicates (pinned tweet appears on every page)
                if (seenIds.has(tweet.id)) continue;
                seenIds.add(tweet.id);

                // Inject author info — X omits user data from UserTweets responses
                if (!tweet.author_name && currentExport.userInfo) {
                    tweet.author_name = currentExport.userInfo.name || '';
                    tweet.author_username = currentExport.userInfo.screenName || currentExport.username || '';
                    // Fix tweet_url if it contains 'undefined'
                    if (tweet.tweet_url && tweet.tweet_url.includes('/undefined/')) {
                        tweet.tweet_url = tweet.tweet_url.replace('/undefined/', `/${tweet.author_username}/`);
                    }
                }

                currentExport.tweetBuffer.push(tweet);
                currentExport.tweetCount++;

                // Save batch when buffer is full
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

            // Save progress
            await saveCurrentState();

            // Broadcast progress
            broadcastStatus({
                running: true,
                status: 'fetching',
                username: currentExport.username,
                tweetCount: currentExport.tweetCount,
                expectedTweets: currentExport.userInfo?.tweetCount || 0,
                quantityLimit: currentExport.settings?.quantityLimit || 0,
                batch: Math.floor(rateLimiter.totalRequests / rateLimiter.batchSize) + 1,
                totalRequests: rateLimiter.totalRequests
            });
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
            username: currentExport.username
        });

    } catch (error) {
        if (error.message === 'ABORTED') {
            // Flush remaining buffer before stopping so CSV download works
            if (currentExport.tweetBuffer.length > 0) {
                await XPorterStorage.saveTweetBatch(currentExport.totalBatches, currentExport.tweetBuffer);
                currentExport.totalBatches++;
                currentExport.tweetBuffer = [];
            }
            currentExport.running = false;
            currentExport.status = 'stopped';
            await saveCurrentState();
            broadcastStatus({ running: false, status: 'stopped', tweetCount: currentExport.tweetCount, canResume: true });
        } else {
            throw error;
        }
    }
}

async function stopExport() {
    if (currentExport) {
        currentExport.running = false;
        // Flush any remaining tweet buffer to storage so CSV download works
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
        broadcastStatus(event);
    });

    currentExport = {
        running: true,
        username: savedState.username,
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

    // Continue the export loop
    runExportLoop().catch(err => {
        console.error('Resume export error:', err);
        if (currentExport) {
            currentExport.running = false;
            currentExport.status = 'error';
            currentExport.error = err.message;
            saveCurrentState();
            broadcastStatus({ running: false, status: 'error', error: err.message });
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
            canResume: !currentExport.running && (currentExport.status === 'stopped' || currentExport.status === 'error')
        };
    }

    // Check saved state
    const savedState = await XPorterStorage.loadExportState();
    if (savedState) {
        const savedSettings = await XPorterStorage.loadSettings();
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
            canResume: savedState.status === 'stopped' || savedState.status === 'error'
        };
    }

    return { running: false, status: 'idle' };
}

async function downloadCSV() {
    const allTweets = await XPorterStorage.loadAllTweets();

    if (allTweets.length === 0) {
        return { error: 'No tweets to download' };
    }

    const state = await XPorterStorage.loadExportState();
    const username = state?.username || 'unknown';

    const csvString = XPorterCSV.generateCSV(allTweets);
    const filename = XPorterCSV.generateFilename(username);

    // Create blob and download
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const reader = new FileReader();

    return new Promise((resolve) => {
        reader.onload = () => {
            const dataUrl = reader.result;
            chrome.downloads.download({
                url: dataUrl,
                filename: filename,
                saveAs: true
            }, (downloadId) => {
                resolve({ success: true, downloadId, tweetCount: allTweets.length, filename });
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
        // Mark as stopped so user can explicitly resume
        state.running = false;
        state.status = 'stopped';
        await XPorterStorage.saveExportState(state);
    }
});

// Also check on install/update
chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
        // Set default settings
        await XPorterStorage.saveSettings({
            includeRetweets: true,
            includeReplies: true,
            quantityLimit: 500,
            requestDelay: 3000,
            batchSize: 20,
            cooldownDuration: 180000,
            theme: 'dark'
        });
    }
});
