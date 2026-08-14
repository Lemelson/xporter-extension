// XPorter — Background Service Worker
// Orchestrates the export process and handles popup/content-script messages

// Import utility scripts (paths relative to this service worker's location)
importScripts(
    '../utils/config.js',
    '../utils/api-features.js',
    '../utils/api-parsers.js',
    '../utils/native-request-template.js',
    '../utils/transaction-id.js',
    '../utils/api.js',
    '../utils/rateLimit.js',
    '../utils/columns-i18n.js',
    '../utils/csv.js',
    '../utils/storage.js',
    '../utils/post-database.js',
    '../popup/i18n.js', // loadTranslations() — used to localize the in-page capture overlay
    './uninstall-feedback.js',
    './downloads.js'
);

// Export batches, history, settings, and usage counters are worker/UI data.
// Content scripts do not need direct storage access; keep X page contexts from
// reading them and route their legitimate operations through runtime messages.
if (chrome.storage?.local?.setAccessLevel) {
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
}

// Current export state
let currentExport = null;
let rateLimiter = null;
let bookmarkContextRateLimiter = null;
let aboutRateLimiter = null;
let aboutAccountCache = null;
let searchCapture = null;
let exportLoopPromise = null;
let lastTransientStatus = null;
let manualWaitUntil = null;

const RATE_LIMIT_KEYS_BY_MODE = {
    posts: 'UserTweets',
    bookmarks: 'Bookmarks',
    bookmark_context: 'TweetResultsByRestIds',
    followers: 'Followers',
    following: 'Following',
    verified_followers: 'BlueVerifiedFollowers'
};

function rateLimitKeyForMode(mode, settings) {
    if (mode === 'about_account') return 'AboutAccountQuery';
    if (mode === 'posts' && settings?.includeReplies === true) {
        return 'UserTweetsAndReplies';
    }
    return RATE_LIMIT_KEYS_BY_MODE[mode];
}

// Synchronous latch closing the async window between the `running` check and
// `currentExport` assignment in start/resume (two rapid START_EXPORT messages
// could otherwise both pass the guard and spawn two competing loops).
let exportStarting = false;

// Clamp a user-typed custom-speed value to its [min, max, default] range.
function clampCustomSpeed(value, range) {
    const [min, max, def] = range || [];
    let v = Number(value);
    if (!Number.isFinite(v)) v = def;
    if (Number.isFinite(min)) v = Math.max(min, v);
    if (Number.isFinite(max)) v = Math.min(max, v);
    return v;
}

function resolveAboutAccountMaxRetries(settings = {}) {
    const [min, max, fallback] =
        XPORTER_CONFIG.ABOUT_ACCOUNT_RETRY_RANGE || [1, 1440, 5];
    const requested = Number.parseInt(settings.aboutAccountMaxRetries, 10);
    const value = Number.isFinite(requested) ? requested : fallback;
    return Math.max(min, Math.min(max, value));
}

// Build the effective pacing preset for the export mode. Posts and user-list
// exports have independent saved controls because their X endpoints have very
// different budgets and safe fallback delays.
function resolveSpeedPreset(settings, mode = 'posts') {
    const presets = XPORTER_CONFIG.SPEED_PRESETS || {};
    const isUserList = mode !== 'posts' && mode !== 'bookmarks' && mode !== 'bookmark_context';
    const speed = settings[isUserList ? 'userExportSpeed' : 'exportSpeed'] || 'standard';
    const customDelayKey = isUserList ? 'userCustomDelaySec' : 'customDelaySec';
    const customBatchKey = isUserList ? 'userCustomBatchSize' : 'customBatchSize';
    const customCooldownKey = isUserList ? 'userCustomCooldownMin' : 'customCooldownMin';
    if (speed === 'custom') {
        const L = XPORTER_CONFIG.CUSTOM_SPEED_LIMITS || {};
        const delayMs = clampCustomSpeed(settings[customDelayKey], L.delaySec) * 1000;
        return {
            adaptiveFloor: delayMs,
            adaptivePad: 1000,
            budgetFraction: 1,
            // The user picked an explicit pace. Keep it even when X's
            // advertised budget runs low; only a real failure may pause.
            raceReserve: 2,
            batchSize: clampCustomSpeed(settings[customBatchKey], L.batch),
            cooldownDuration: clampCustomSpeed(settings[customCooldownKey], L.cooldownMin) * 60000,
            alwaysBatchCooldown: true,
            // Headerless fallback also runs at the user's chosen pace.
            customFallbackDelays: [delayMs, delayMs + 2000]
        };
    }
    return presets[speed] || presets.standard || {};
}

function buildRateLimiterOptions(settings, mode) {
    const adaptivePacing = settings.adaptivePacing !== false;
    // Everything else (floors, pads, fallback delays, batch rhythm) is derived
    // from the mode-specific user-facing speed control.
    const preset = resolveSpeedPreset(settings, mode);
    const configuredFallback = adaptivePacing
        ? (preset.customFallbackDelays || XPORTER_CONFIG.FALLBACK_REQUEST_DELAYS?.[mode])
        : null;
    const scale = preset.fallbackScale || 1;
    const fallbackMinDelay = Math.round((configuredFallback?.[0] || settings.requestDelay) * scale);
    const fallbackMaxDelay = Math.round((configuredFallback?.[1] || fallbackMinDelay / scale) * scale);
    const endpointKey = rateLimitKeyForMode(mode, settings);

    return {
        requestDelay: settings.requestDelay,
        batchSize: preset.batchSize || settings.batchSize,
        cooldownDuration: preset.cooldownDuration || settings.cooldownDuration,
        adaptiveFloor: preset.adaptiveFloor,
        adaptivePad: preset.adaptivePad,
        budgetFraction: preset.budgetFraction,
        raceReserve: preset.raceReserve,
        alwaysBatchCooldown: preset.alwaysBatchCooldown,
        adaptivePacing,
        maxRetries: mode === 'about_account'
            ? resolveAboutAccountMaxRetries(settings)
            : undefined,
        fallbackMinDelay,
        fallbackMaxDelay,
        rateLimitProvider: () => (
            endpointKey && typeof XPorterAPI?.getRateLimit === 'function'
                ? XPorterAPI.getRateLimit(endpointKey)
                : null
        )
    };
}

function createRateLimiter(settings, mode) {
    return new RateLimitManager(buildRateLimiterOptions(settings, mode));
}

// ==================== Overlay i18n (date-range capture overlay) ====================
// The in-page overlay shown on x.com during a date-range export lives in the page
// context and can't load the popup locale files itself. The worker loads the user's
// language here and ships ready-to-render strings to the content script.
let _overlayI18n = null;

async function getOverlayI18n() {
    if (_overlayI18n) return _overlayI18n;
    let lang = 'en';
    try {
        const settings = await XPorterStorage.loadSettings();
        lang = settings.language || (typeof detectBrowserLanguage === 'function' ? detectBrowserLanguage() : 'en');
    } catch (_) { /* default en */ }
    let tr = {};
    try {
        if (typeof loadTranslations === 'function') tr = await loadTranslations(lang);
    } catch (_) { /* default en fallbacks below */ }
    const g = (k, fallback) => (tr[k] !== undefined ? tr[k] : fallback);
    const dir = ['ar', 'fa', 'he', 'ur'].includes(lang) ? 'rtl' : 'ltr';
    const strings = {
        lang,
        dir,
        title: g('ovTitle', 'XPorter date range export'),
        note: g('ovNote', 'Keep this tab open. XPorter is scrolling it to collect posts.'),
        collapse: g('ovCollapse', 'Collapse XPorter status'),
        expand: g('ovExpand', 'Expand XPorter status'),
        noLimit: g('ovNoLimit', 'No post limit'),
        limitLabel: g('ovLimit', 'Limit:'),
        postsCollected: g('postsCollected', 'posts collected'),
        posts: g('posts', 'posts'),
        preparingFor: g('ovPreparing', 'Preparing search for'),
        preparingPage: g('ovPreparingPage', 'Preparing search page...'),
        exportingFor: g('ovExportingFor', 'Exporting'),
        scrollingFor: g('ovScrolling', 'Scrolling X search for'),
        stop: g('ovStop', 'Stop export'),
        stopping: g('ovStopping', 'Stopping…'),
        rateLimited: g('ovRateLimited', 'X rate limit — retrying in'),
        resumingFor: g('ovResuming', 'Resuming — checking already saved posts for'),
        almostDone: g('ovAlmostDone', "Looks like that's all the posts in this range — you can stop the export")
    };
    // Cache only when the locale really loaded. Caching the silent English
    // fallback pinned the overlay to English for the SW's whole lifetime
    // even though the popup UI was localized (seen in the field: RU popup,
    // English overlay).
    if (tr && Object.keys(tr).length > 0) {
        _overlayI18n = strings;
    }
    return strings;
}

// Build a localized overlay subtitle for a given phase key.
function overlayPhase(i18n, phaseKey, username, resumeScanned = 0) {
    const u = username || 'profile';
    switch (phaseKey) {
        case 'preparing': return `${i18n.preparingFor} @${u}...`;
        case 'resuming':
            return `${i18n.resumingFor} @${u} (${Number(resumeScanned) || 0} ${i18n.posts})...`;
        case 'scrolling': return `${i18n.scrollingFor} @${u}...`;
        case 'exporting':
        default: return `${i18n.exportingFor} @${u}...`;
    }
}

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

        case 'SET_CURRENT_ACCOUNT':
            return {
                success: await XPorterStorage.saveCurrentAccount(message.account)
            };

        case 'GET_CURRENT_ACCOUNT':
            return {
                account: await XPorterStorage.loadCurrentAccount()
            };

        case 'START_EXPORT':
            return await startExport(message);

        case 'STOP_EXPORT':
            return stopExport();

        case 'GET_STATUS': {
            const exportStatus = await getExportStatus();
            // A UI is now showing this state — a lingering terminal badge
            // (✓ / ! / II) has done its job and would only go stale.
            if (!exportStatus?.running) setBadge('');
            return exportStatus;
        }

        case 'DOWNLOAD_CSV':
        case 'DOWNLOAD_EXPORT':
            return await XPorterDownloads.startCurrentDownload(message.outputFormat);

        case 'GET_DOWNLOAD_PLAN':
            return await XPorterDownloads.getCurrentPlan(message.outputFormat);

        case 'GET_EXPORT_TEXT':
            return await XPorterDownloads.getCurrentPostsText();

        case 'DOWNLOAD_HISTORY_ENTRY':
            await applyAutoExpiration();
            return await XPorterDownloads.downloadHistory(message.id, message.outputFormat);

        case 'RESUME_EXPORT':
            return await resumeExport(message.extraItems);

        case 'RESUME_POSTS_ONLY':
            return await resumePostsOnly();

        case 'SAVE_SETTINGS':
            if (!await XPorterStorage.saveSettings(message.settings)) {
                return { error: 'STORAGE_FULL' };
            }
            if (applyLivePacingSettings(message.settings)) {
                await saveCurrentState({ bestEffort: true });
            }
            _overlayI18n = null; // language may have changed — reload overlay strings lazily
            await applyAutoExpiration();
            XPorterFeedback.refresh(); // keep language/theme/settings snapshot fresh
            return { success: true };

        case 'GET_SETTINGS':
            const settings = await XPorterStorage.loadSettings();
            return { settings };

        case 'CLEAR_EXPORT':
            if (exportLoopPromise) {
                return { error: 'ALREADY_RUNNING' };
            }
            if (!await XPorterStorage.clearExportState()) {
                return { error: 'STORAGE_FULL' };
            }
            currentExport = null;
            setBadge('');
            return { success: true };

        case 'DISCOVERED_REQUEST_TEMPLATE': {
            if (!isXPageSender(sender)) return { error: 'INVALID_SENDER' };
            const template = globalThis.XPorterNativeTemplate
                ?.sanitizeWireTemplate(message.template);
            if (!template) return { error: 'INVALID_TEMPLATE' };
            const accepted = await XPorterAPI.setLiveRequestTemplate(template);
            return accepted ? { success: true } : { error: 'INVALID_TEMPLATE' };
        }

        case 'PAGE_GRAPHQL_RESPONSE':
            return handlePageGraphqlResponse(message, sender);

        case 'CAPTURE_FEED_POSTS':
            if (!isXPageSender(sender)) return { error: 'INVALID_SENDER' };
            if (typeof message.operationName !== 'string' ||
                !/(Timeline|Tweets|TweetDetail|Bookmarks|Likes|Community|ListLatest|UserMedia)/i.test(message.operationName) ||
                !Array.isArray(message.posts) || message.posts.length === 0 || message.posts.length > 250) {
                return { error: 'INVALID_POSTS' };
            }
            return XPorterPostDB.upsertPosts(message.posts, {
                operationName: message.operationName
            });

        case 'GET_FEED_DB_SUMMARY':
            return XPorterPostDB.getSummary();

        case 'DOWNLOAD_FEED_DB':
            return XPorterDownloads.downloadSeenPosts(message.outputFormat);

        case 'CLEAR_FEED_DB':
            await XPorterPostDB.clear();
            return { success: true };

        case 'GET_EXPORT_HISTORY':
            await applyAutoExpiration();
            const history = await XPorterStorage.loadExportHistory();
            return { history: history.map(({ items, ...entry }) => entry) };

        case 'DELETE_HISTORY_ENTRY':
            return await XPorterStorage.deleteExportHistoryEntry(message.id)
                ? { success: true }
                : { error: 'STORAGE_FULL' };

        case 'CLEAR_HISTORY':
            return await XPorterStorage.clearExportHistory()
                ? { success: true }
                : { error: 'STORAGE_FULL' };

        case 'XP_SESSION_OPEN':
            // Popup was opened — count it and refresh the snapshot.
            await XPorterStorage.recordOpen();
            XPorterFeedback.refresh();
            return { success: true };

        case 'XP_ACTIVE_TICK':
            // Accumulated active (visible) time in the UI. Refresh is throttled
            // unless the page is unloading (flush) so we don't churn on every tick.
            await XPorterStorage.addActiveMs(message.ms);
            XPorterFeedback.maybeRefresh(message.flush);
            return { success: true };

        default:
            return { error: 'Unknown message type' };
    }
}

function isXPageSender(sender) {
    try {
        const url = new URL(sender?.tab?.url || '');
        return url.protocol === 'https:' && (url.hostname === 'x.com' || url.hostname === 'twitter.com');
    } catch (_) {
        return false;
    }
}

// ==================== Export Engine ====================

// A stopped export's loop unwinds asynchronously (final flush + persist +
// tab close). Start/Resume gate on exportLoopPromise, so a fast Stop → Resume
// raced that unwind and returned ALREADY_RUNNING for an export the UI already
// showed as stopped. Wait (bounded) for the loop to actually exit first.
async function waitForLoopUnwind(ms = 8000) {
    if (!exportLoopPromise || currentExport?.running) return;
    await Promise.race([
        exportLoopPromise,
        new Promise(resolve => setTimeout(resolve, ms))
    ]);
}

async function startExport({ username, dateFrom, dateTo, exportMode, outputFormat }) {
    await waitForLoopUnwind();
    if (exportStarting || exportLoopPromise || (currentExport && currentExport.running)) {
        return { error: 'ALREADY_RUNNING' };
    }
    exportStarting = true;

    try {
        return await _startExportInner({ username, dateFrom, dateTo, exportMode, outputFormat });
    } finally {
        exportStarting = false;
    }
}

async function _startExportInner({ username, dateFrom, dateTo, exportMode, outputFormat }) {
    const settings = await XPorterStorage.loadSettings();
    const mode = exportMode || 'posts';
    const isBookmarks = mode === 'bookmarks';
    const normalizedDateFrom = (mode === 'posts') ? normalizeDateBoundary(dateFrom, 'start') : null;
    const normalizedDateTo = (mode === 'posts') ? normalizeDateBoundary(dateTo, 'end') : null;

    if (normalizedDateFrom && normalizedDateTo && normalizedDateFrom > normalizedDateTo) {
        return { error: 'INVALID_DATE_RANGE' };
    }

    // Initialize rate limiter with current settings. The provider lets it pace
    // adaptively from X's live x-rate-limit-* budget (fixed delay is fallback).
    rateLimiter = createRateLimiter(settings, mode);
    bookmarkContextRateLimiter = null;
    aboutRateLimiter = null;
    aboutAccountCache = null;
    lastTransientStatus = null;
    _overlayI18n = null; // re-read the UI language for this export's overlay

    rateLimiter.onStatusChange((event) => {
        lastTransientStatus = event;
        broadcastStatus({ ...event, exportMode: mode });
    });

    // Clear previous export data
    if (!await XPorterStorage.clearExportState()) {
        return { error: 'STORAGE_FULL' };
    }

    currentExport = {
        running: true,
        // Bookmarks are owned by the signed-in viewer. Never carry a typed or
        // tab-detected profile handle into this personal export.
        username: isBookmarks ? '' : username,
        exportMode: mode,
        outputFormat: outputFormat || 'csv',
        dateFrom: normalizedDateFrom,
        dateTo: normalizedDateTo,
        settings: settings,
        tweetCount: 0, // used for both tweets and users (item count)
        itemsRecordedBase: 0,
        totalBatches: 0,
        tweetBuffer: [], // used for both tweets and users
        userId: isBookmarks ? 'current-account' : null,
        userInfo: isBookmarks
            ? { name: '', screenName: '', tweetCount: null }
            : null,
        cursor: null,
        startedAt: Date.now(),
        status: 'resolving_user',
        completionReason: null
    };

    // Save initial state before acknowledging the start. A failed write must
    // not leave an in-memory export marked running with no loop behind it.
    try {
        await saveCurrentState();
    } catch (error) {
        currentExport = null;
        rateLimiter = null;
        return { error: error.message };
    }

    // Anonymous usage counter (for uninstall feedback) — fire and forget
    XPorterStorage.recordExportStart(mode, outputFormat, {
        dateRange: !!(normalizedDateFrom || normalizedDateTo)
    }).then(XPorterFeedback.refresh).catch(() => {});
    _lastRecordedUsagePhase = 'resolving_user';

    // Start the export process (non-blocking)
    launchExportLoop('Export loop error:');
    if (isBookmarks) {
        // Opening the viewer-owned page both gives the user the expected X
        // context and lets the MAIN-world interceptor capture X's current,
        // accepted Bookmarks request template for query-ID rotation recovery.
        Promise.resolve()
            .then(() => chrome.tabs.create({
                url: 'https://x.com/i/bookmarks',
                active: true
            }))
            .catch((error) => XLog.warn('Could not open Bookmarks tab:', error.message));
    }

    return { success: true, status: 'started' };
}

async function runExportLoop() {
    try {
        // Step 1: Resolve the user only for a fresh export. Resume already has
        // the trusted user snapshot; repeating this unrelated request would
        // reset the restored endpoint pacing counters and flash the UI to zero.
        let userInfo = currentExport.userInfo;
        if (!currentExport.userId || !userInfo) {
            broadcastStatus({
                running: true,
                status: 'resolving_user',
                username: currentExport.username,
                exportMode: currentExport.exportMode
            });

            try {
                // Resolve through the rate limiter: a NETWORK_TIMEOUT or 429
                // gets the same visible retries as any page fetch.
                userInfo = await rateLimiter.executeWithRateLimit(() =>
                    XPorterAPI.getUserByScreenName(currentExport.username));
                if (currentExport.exportMode === 'posts') {
                    try {
                        const about = await XPorterAPI.getAccountAbout(
                            userInfo.screenName || currentExport.username
                        );
                        userInfo = { ...userInfo, ...about };
                    } catch (aboutError) {
                        if (aboutError.message === 'ABORTED') throw aboutError;
                        // About this Account is optional metadata. A missing or
                        // temporarily unavailable region must not block the export.
                        XLog.warn('About this Account metadata unavailable:', aboutError.message);
                    }
                }
                // The resolve hits a separate, generous endpoint budget — don't
                // let it count as request #1 for a fresh export.
                rateLimiter.requestCount = 0;
                rateLimiter.totalRequests = 0;
                rateLimiter.lastRequestAt = null;
            } catch (err) {
                if (err.message === 'NOT_LOGGED_IN') throw new Error('NOT_LOGGED_IN');
                if (err.message === 'USER_NOT_FOUND') throw new Error('USER_NOT_FOUND');
                if (err.message === 'USER_SUSPENDED') throw new Error('USER_SUSPENDED');
                if (err.message.startsWith('ENDPOINT_DISCOVERY_FAILED')) throw new Error('ENDPOINT_DISCOVERY_FAILED');
                throw err;
            }
        }

        if (userInfo.isProtected) {
            throw new Error('ACCOUNT_PRIVATE');
        }

        currentExport.userId = userInfo.id || currentExport.userId;
        currentExport.userInfo = userInfo;
        currentExport.status = 'fetching';
        recordUsagePhase('fetching');
        await saveCurrentState();

        // Determine expected count based on mode
        const expectedCount = getExpectedItemCount();

        broadcastStatus({
            running: true,
            status: 'fetching',
            username: currentExport.username,
            expectedTweets: expectedCount,
            tweetCount: currentExport.tweetCount,
            exportMode: currentExport.exportMode
        });

        // Step 2: Run the appropriate fetch loop based on mode
        if (currentExport.exportMode === 'posts') {
            await _fetchPostsLoop();
        } else if (currentExport.exportMode === 'bookmarks') {
            await _fetchBookmarksLoop();
        } else {
            await _fetchUsersLoop();
        }

        if (!currentExport.running) {
            await flushExportBuffer();
            currentExport.status = 'stopped';
            await saveCurrentState();
            recordExportStoppedOnce();
            broadcastStopped();
            return;
        }

        // Save remaining buffer
        await flushExportBuffer();

        // Export complete
        currentExport.running = false;
        currentExport.status = 'complete';
        currentExport.completedAt = Date.now();
        await saveCurrentState();

        await saveCompletedExportHistory();

        // Anonymous usage counter (for uninstall feedback) — fire and forget
        const itemsDelta = Math.max(0, currentExport.tweetCount - (currentExport.itemsRecordedBase || 0));
        XPorterStorage.recordExportComplete(itemsDelta).then(XPorterFeedback.refresh).catch(() => {});

        broadcastStatus({
            running: false,
            status: 'complete',
            tweetCount: currentExport.tweetCount,
            username: currentExport.username,
            exportMode: currentExport.exportMode,
            startedAt: currentExport.startedAt,
            completedAt: currentExport.completedAt
        });

    } catch (error) {
        if (error.message === 'ABORTED') {
            // Flush remaining buffer
            await flushExportBuffer();
            currentExport.running = false;
            currentExport.status = 'stopped';
            await saveCurrentState();
            recordExportStoppedOnce();
            broadcastStopped();
        } else {
            throw error;
        }
    }
}

async function saveCompletedExportHistory() {
    const ui = currentExport.userInfo || {};
    const isBookmarks = currentExport.exportMode === 'bookmarks';
    const historyLimit = Number(XPORTER_CONFIG.EXPORT_HISTORY_DATA_LIMIT) || 5000;
    const keepPayload = currentExport.tweetCount <= historyLimit;
    const historyItems = keepPayload ? await XPorterStorage.loadAllTweets() : null;
    await XPorterStorage.saveExportHistory({
        username: isBookmarks ? '' : (ui.screenName || currentExport.username),
        displayName: isBookmarks ? 'Bookmarks' : (ui.name || currentExport.username),
        profileImageUrl: isBookmarks ? '' : (ui.profileImageUrl || ''),
        userInfo: { ...ui },
        exportMode: currentExport.exportMode,
        itemCount: currentExport.tweetCount,
        outputFormat: currentExport.outputFormat || 'csv',
        includeAboutAccountDetails:
            currentExport.settings?.includeAboutAccountDetails === true,
        dateFrom: currentExport.dateFrom?.toISOString() || null,
        dateTo: currentExport.dateTo?.toISOString() || null,
        partialReason: currentExport.partialReason || null,
        completionReason: currentExport.completionReason || null,
        completedAt: currentExport.completedAt || Date.now(),
        ...(historyItems ? { items: historyItems } : {})
    });
}

// ==================== Posts Fetch Loop ====================

// Seed a de-dup set with saved IDs. Cursor-based exports only need a recent
// overlap window, but date-range search capture restarts from the beginning of
// the X search page on resume, so it must preload the whole saved export.
async function preloadSeenIds(seenIds) {
    if (!currentExport || !currentExport.totalBatches) return;
    try {
        if (currentExport.dateFrom || currentExport.dateTo) {
            const savedItems = await XPorterStorage.loadAllTweets();
            for (const item of savedItems) {
                if (item?.id) seenIds.add(item.id);
            }
            return;
        }

        const startBatch = Math.max(0, currentExport.totalBatches - 3);
        for (let i = startBatch; i < currentExport.totalBatches; i++) {
            const batch = await XPorterStorage.loadTweetBatch(i);
            for (const item of batch) {
                if (item?.id) seenIds.add(item.id);
            }
        }
    } catch (_) { /* best-effort dedup */ }
}

// Cursor pagination can overlap around page boundaries, but retaining every ID
// from a multi-million-row run wastes hundreds of MB. Keep only a generous
// recent window; persisted batches remain the source of truth across resumes.
function createRecentIdTracker(seed, requestedLimit) {
    const limit = Math.max(1, Number(requestedLimit) || XPORTER_CONFIG.RECENT_EXPORT_ID_LIMIT || 1000);
    const order = Array.from(seed || []).slice(-limit);
    const seen = new Set(order);
    let nextEviction = 0;

    return {
        add(id) {
            if (seen.has(id)) return false;
            if (seen.size === limit) {
                seen.delete(order[nextEviction]);
                order[nextEviction] = id;
                nextEviction = (nextEviction + 1) % limit;
            } else {
                order.push(id);
            }
            seen.add(id);
            return true;
        },
        get size() { return seen.size; }
    };
}

function quantityLimitReached() {
    const limit = currentExport?.settings?.quantityLimit || 0;
    return limit > 0 && currentExport.tweetCount >= limit;
}

function getExpectedItemCount(exportState = currentExport) {
    const info = exportState?.userInfo || {};
    let value;
    switch (exportState?.exportMode) {
        case 'following':
            value = info.followingCount;
            break;
        case 'followers':
        case 'verified_followers':
            value = info.followersCount;
            break;
        case 'posts':
        default:
            value = info.tweetCount;
            break;
    }
    return Number.isFinite(value) && value >= 0 ? value : null;
}

async function flushExportBuffer() {
    if (!currentExport?.tweetBuffer?.length) return;
    const ok = await XPorterStorage.saveTweetBatch(currentExport.totalBatches, currentExport.tweetBuffer);
    if (!ok) {
        // A failed write (quota, corruption) must abort the export loudly —
        // silently dropping the batch would produce a "successful" export with
        // missing rows. Everything already persisted stays downloadable.
        // The in-memory rows are not downloadable and will disappear when the
        // worker stops. Roll the public count back to the persisted count so a
        // resume can refetch this page instead of stopping early at the limit.
        currentExport.tweetCount = Math.max(0, currentExport.tweetCount - currentExport.tweetBuffer.length);
        currentExport.tweetBuffer = [];
        throw new Error('STORAGE_FULL');
    }
    currentExport.totalBatches++;
    currentExport.tweetBuffer = [];
}

async function _fetchPostsLoop() {
    if (currentExport.dateFrom || currentExport.dateTo) {
        await _fetchPostsByDateRangeLoop();
        return;
    }

    const expectedUsername =
        currentExport.userInfo?.screenName || currentExport.username || '';
    await _fetchPostTimelineLoop(
        (cursor) => XPorterAPI.fetchUserTweets(
            currentExport.userId,
            cursor,
            20,
            currentExport.settings.includeReplies === true
        ),
        (tweet) => {
            if (!currentExport.settings.includeRetweets && tweet.type === 'retweet') return false;
            if (!currentExport.settings.includeReplies && tweet.type === 'reply') return false;
            if (currentExport.settings.includeArticles === false && tweet.type === 'article') return false;

            // UserTweetsAndReplies contains foreign conversation rows so X can
            // draw the Replies tab. The parser has already attached a matching
            // direct parent (and any quote inside it) to the profile reply as
            // `reply_to_post`; filter only the standalone foreign row.
            return !(tweet.author_username && expectedUsername &&
                tweet.author_username.toLowerCase() !== expectedUsername.toLowerCase());
        }
    );
}

async function _fetchBookmarksLoop() {
    // A bookmark is a primary row because the viewer explicitly saved it.
    // Do not apply profile-author, repost, reply, or article filters here.
    await _fetchPostTimelineLoop(
        async (cursor) => {
            const page = await XPorterAPI.fetchBookmarks(cursor, 20);
            if (currentExport.settings.includeBookmarkReplyContext !== false) {
                await enrichBookmarkReplyContexts(page.tweets || []);
            }
            if (currentExport.settings.includeBookmarkArticles === false) {
                for (const tweet of (page.tweets || [])) {
                    removeArticlePayload(tweet);
                }
            }
            return page;
        },
        () => true
    );
}

function removeArticlePayload(post, seen = new Set()) {
    if (!post || typeof post !== 'object' || seen.has(post)) return;
    seen.add(post);
    post.article_title = '';
    post.article_url = '';
    post.article_text = '';
    removeArticlePayload(post.reply_to_post, seen);
    removeArticlePayload(post.quoted_post, seen);
}

async function enrichBookmarkReplyContexts(tweets) {
    const parentIds = [...new Set(tweets
        .filter((tweet) => tweet?.reply_to_id && !tweet.reply_to_post)
        .map((tweet) => String(tweet.reply_to_id)))];
    if (parentIds.length === 0) return;

    if (!bookmarkContextRateLimiter) {
        bookmarkContextRateLimiter = createRateLimiter(
            currentExport.settings,
            'bookmark_context'
        );
        bookmarkContextRateLimiter.onStatusChange((event) => {
            lastTransientStatus = event;
            broadcastStatus({ ...event, exportMode: 'bookmarks' });
        });
    }
    const parents = await bookmarkContextRateLimiter.executeWithRateLimit(
        () => XPorterAPI.fetchTweetsByIds(parentIds)
    );
    const parentById = new Map((parents || []).map((parent) => [
        String(parent.id),
        parent
    ]));
    for (const tweet of tweets) {
        if (!tweet?.reply_to_id || tweet.reply_to_post) continue;
        const parent = parentById.get(String(tweet.reply_to_id));
        if (parent) {
            tweet.reply_to_post = XPorterAPI.toPostContext(parent);
        }
    }
}

async function _fetchPostTimelineLoop(fetchPage, acceptTweet) {
    let hasMore = true;
    let noProgressPages = 0;
    const seenIds = new Set();
    await preloadSeenIds(seenIds);
    const recentIds = createRecentIdTracker(seenIds);

    while (hasMore && currentExport.running) {
        // Check quantity limit
        if (quantityLimitReached()) {
            currentExport.completionReason = 'limit_reached';
            break;
        }

        const requestCursor = currentExport.cursor;
        const result = await rateLimiter.executeWithRateLimit(() => fetchPage(requestCursor));
        if (!currentExport.running) break;

        const countBeforePage = currentExport.tweetCount;

        for (const tweet of (result.tweets || [])) {
            if (!acceptTweet(tweet)) continue;

            if (!recentIds.add(tweet.id)) continue;
            if (quantityLimitReached()) {
                hasMore = false;
                break;
            }
            // Profile timelines can omit repeated author fields. Bookmark
            // rows are authored by arbitrary accounts, so never inject the
            // viewer sentinel into those rows.
            if (currentExport.exportMode === 'posts' &&
                !tweet.author_name && currentExport.userInfo) {
                tweet.author_name = currentExport.userInfo.name || '';
                tweet.author_username = currentExport.userInfo.screenName || currentExport.username || '';
                if (tweet.tweet_url && tweet.tweet_url.includes('/undefined/')) {
                    tweet.tweet_url = tweet.tweet_url.replace('/undefined/', `/${tweet.author_username}/`);
                }
            }

            currentExport.tweetBuffer.push(tweet);
            currentExport.tweetCount++;
            recordFirstItemOnce();

            if (currentExport.tweetBuffer.length >= XPorterStorage.MAX_TWEETS_PER_BATCH) {
                await flushExportBuffer();
            }
        }

        if (quantityLimitReached()) {
            hasMore = false;
            currentExport.completionReason = 'limit_reached';
        }

        // Forward progress is measured AFTER filtering and de-duplication. X
        // occasionally repeats a non-empty page with the same cursor; treating
        // raw rows as progress made the loop spin forever at a fixed count and
        // every Resume repeated the same no-op page.
        const acceptedNew = currentExport.tweetCount - countBeforePage;
        const cursorAdvanced = !!result.nextCursor && result.nextCursor !== requestCursor;
        noProgressPages = (acceptedNew > 0 || cursorAdvanced) ? 0 : (noProgressPages + 1);

        // Update cursor
        // Keep the current cursor when stopping on a quantity limit so resume
        // can refetch the same page and skip already-saved IDs.
        if (hasMore && cursorAdvanced) {
            currentExport.cursor = result.nextCursor;
        } else if (hasMore && !result.nextCursor) {
            currentExport.completionReason = 'source_exhausted';
            currentExport.cursor = null;
            hasMore = false;
        } else if (hasMore && noProgressPages >= 3) {
            currentExport.completionReason = 'source_exhausted';
            currentExport.cursor = null;
            hasMore = false;
        }

        // Persist the buffer BEFORE the advanced cursor: if the SW dies after
        // saveCurrentState, resume starts past these items with an empty buffer
        // and they would be lost forever.
        await flushExportBuffer();
        await saveCurrentState();

        broadcastStatus({
            running: true,
            status: 'fetching',
            username: currentExport.username,
            tweetCount: currentExport.tweetCount,
            expectedTweets: getExpectedItemCount(),
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
    await preloadSeenIds(seenIds);
    const recentIds = createRecentIdTracker(seenIds);
    const rawQuery = buildDateRangeSearchQuery(currentExport.username, currentExport.dateFrom, currentExport.dateTo);
    let payload = null;

    await openSearchCaptureTab(rawQuery);

    try {
        payload = await waitForSearchCapturePayload(20000);
        // Slow machines/connections routinely need more than 20s for X's
        // search page to boot (real churn case: SEARCH_CAPTURE_TIMEOUT on the
        // most engaged user we ever lost). Before giving up, actively ping the
        // capture tab — requestNextSearchCapturePayload retries with scroll
        // nudges for up to ~48 more seconds.
        if (!payload) {
            payload = await requestNextSearchCapturePayload();
        }
        if (!payload) {
            throw new Error('SEARCH_CAPTURE_TIMEOUT');
        }
        await sendSearchCaptureStatus({ phaseKey: 'exporting' });

        let badPageStreak = 0;

        while (hasMore && currentExport.running) {
            if (quantityLimitReached()) {
                currentExport.completionReason = 'limit_reached';
                break;
            }

            // A captured payload can be an X error response (e.g. 429 while the
            // search tab is rate-limited) or a truncated body. Neither must be
            // counted as an "empty page" — that would end the export as
            // "complete" with a fraction of the range. Pause and re-request.
            let parsedPayload = null;
            if (payload.status >= 400) {
                badPageStreak++;
                if (badPageStreak > 5) throw new Error('RATE_LIMITED');
                const waitMs = payload.status === 429 ? 60000 : 10000;
                lastTransientStatus = {
                    running: true,
                    status: 'cooldown',
                    duration: waitMs,
                    until: Date.now() + waitMs,
                    kind: 'window',
                    reason: `SearchTimeline HTTP ${payload.status}`
                };
                broadcastStatus(lastTransientStatus);
                // Mirror the pause on the in-page overlay (amber countdown).
                await sendSearchCaptureStatus({ pauseUntil: Date.now() + waitMs });
                await swSleep(waitMs);
                if (!currentExport.running) break;
                await sendSearchCaptureStatus({ phaseKey: 'scrolling' });
                payload = await requestNextSearchCapturePayload();
                if (!payload && !searchLikelyComplete()) payload = await recoverStalledSearchCapture();
                if (!payload) {
                    if (currentExport.running && !searchLikelyComplete()) {
                        await flushExportBuffer();
                        await saveCurrentState();
                        throw new Error('RATE_LIMITED');
                    }
                    hasMore = false;
                }
                continue;
            }
            try {
                parsedPayload = XPorterAPI.parseSearchTimelineResponse(JSON.parse(payload.bodyText));
            } catch (_) {
                badPageStreak++;
                if (badPageStreak > 5) throw new Error('SEARCH_CAPTURE_TIMEOUT');
                // Let a retry of the same cursor URL through. The first response
                // was unusable, so treating the URL as permanently seen would
                // discard the later successful response and force a timeout.
                searchCapture?.seenUrls.delete(payload.url);
                payload = await requestNextSearchCapturePayload();
                if (!payload) hasMore = false;
                continue;
            }
            badPageStreak = 0;
            if (!currentExport.running) break;

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
                // Resume replays X Search from the top and most early rows are
                // already saved. They still prove how far back through the date
                // range the page has reached; record coverage before filters and
                // de-duplication so a completed replay does not look stalled.
                noteSearchTimelineCoverage(tweet);
                if (!currentExport.settings.includeRetweets && tweet.type === 'retweet') continue;
                if (!currentExport.settings.includeReplies && tweet.type === 'reply') continue;
                if (currentExport.settings.includeArticles === false && tweet.type === 'article') continue;
                if (seenIds.has(tweet.id)) {
                    if (currentExport.dateResume && searchCapture) {
                        searchCapture.resumeScanned = (searchCapture.resumeScanned || 0) + 1;
                    }
                    continue;
                }
                if (quantityLimitReached()) {
                    hasMore = false;
                    break;
                }
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
                recordFirstItemOnce();

                if (currentExport.tweetBuffer.length >= XPorterStorage.MAX_TWEETS_PER_BATCH) {
                    await flushExportBuffer();
                }
            }

            if (quantityLimitReached()) {
                hasMore = false;
                currentExport.completionReason = 'limit_reached';
            }
            if (hasMore && parsedPayload.nextCursor) {
                currentExport.cursor = parsedPayload.nextCursor;
                await sendSearchCaptureStatus({ phaseKey: 'scrolling' });
                payload = await requestNextSearchCapturePayload();
                // A cursor means X advertised more results — silence here is a
                // stalled/blocked timeline ("Something went wrong"), NOT the
                // end of data. Wait it out and retry; content.js clicks Retry
                // on every scroll ping. Never fake a "complete" — EXCEPT when:
                //  · the collected posts already reach (≥95% cover) the start
                //    of the requested range — silence IS the end there; or
                //  · the last page(s) were EMPTY (e.g. a range with no posts:
                //    X renders "No results", there is nothing to scroll, so no
                //    new request will ever fire). Recovering for minutes and
                //    then failing RATE_LIMITED turned "0 posts in range" into
                //    a fake error.
                const silenceIsEnd = () => emptyPages > 0 || searchLikelyComplete();
                if (!payload && !silenceIsEnd()) payload = await recoverStalledSearchCapture();
                if (!payload) {
                    if (currentExport.running && !silenceIsEnd()) {
                        await flushExportBuffer();
                        await saveCurrentState();
                        throw new Error('RATE_LIMITED');
                    }
                    hasMore = false;
                }
            } else {
                hasMore = false;
            }

            await flushExportBuffer();
            await saveCurrentState();
            await sendSearchCaptureStatus({ phaseKey: 'exporting' });

            broadcastStatus({
                running: true,
                status: 'fetching',
                username: currentExport.username,
                tweetCount: currentExport.tweetCount,
                expectedTweets: getExpectedItemCount(),
                quantityLimit: currentExport.settings?.quantityLimit || 0,
                batch: Math.floor(rateLimiter.totalRequests / rateLimiter.batchSize) + 1,
                totalRequests: rateLimiter.totalRequests,
                exportMode: currentExport.exportMode
            });
        }
        if (currentExport.running && !currentExport.completionReason) {
            currentExport.completionReason = quantityLimitReached()
                ? 'limit_reached'
                : 'source_exhausted';
            if (currentExport.completionReason === 'source_exhausted') {
                currentExport.cursor = null;
            }
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

// The live search feed runs newest → oldest, so once the oldest collected
// post sits within a day of the range start, a silent timeline means the end
// of the data — NOT a stall. Finishing cleanly here beats minutes of pointless
// rate-limit retries and a "failed" export stuck at 98%.
function dateRangeCovered() {
    const fromMs = toEpochMs(currentExport?.dateFrom);
    const oldest = searchCapture?.oldestCollectedMs;
    if (!Number.isFinite(fromMs) || !Number.isFinite(oldest)) return false;
    return (oldest - fromMs) <= 24 * 60 * 60 * 1000;
}

// How much of the requested date window is already collected, in percent.
// Date coverage only — never the quantity-limit progress, which measures a
// different thing (a user stopping at their own limit is not "out of posts").
function computeDateCoveragePct() {
    const fromMs = toEpochMs(currentExport?.dateFrom);
    let toMs = toEpochMs(currentExport?.dateTo);
    const oldest = searchCapture?.oldestCollectedMs;
    if (!Number.isFinite(fromMs) || !Number.isFinite(oldest)) return null;
    if (!Number.isFinite(toMs)) toMs = Date.now();
    if (toMs <= fromMs) return null;
    return Math.min(100, Math.max(0, ((toMs - oldest) / (toMs - fromMs)) * 100));
}

// Real churn case: oldest post in range was Jan 2 with the range starting
// Jan 1 — 38h gap, so the 24h rule alone kept "recovering" a finished export.
// ≥95% of the window collected + a silent timeline = done for all practical
// purposes; the sliver left is a gap in the user's posting, not missing data.
function searchLikelyComplete() {
    if (dateRangeCovered()) return true;
    const pct = computeDateCoveragePct();
    return Number.isFinite(pct) && pct >= 95;
}

function noteSearchTimelineCoverage(tweet) {
    const createdMs = toEpochMs(tweet?.created_at);
    if (!Number.isFinite(createdMs) || !searchCapture) return;
    searchCapture.oldestCollectedMs = Math.min(
        searchCapture.oldestCollectedMs ?? Infinity,
        createdMs
    );
}

function buildSearchTimelinePageUrl(rawQuery) {
    return `https://x.com/search?q=${encodeURIComponent(rawQuery)}&src=typed_query&f=live`;
}

async function openSearchCaptureTab(rawQuery) {
    await closeSearchCaptureTab();

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);

    // Arm the capture state before navigating to X. Creating the tab directly
    // at the search URL leaves a race where document_start can relay the first
    // SearchTimeline response before chrome.tabs.create() resolves; the worker
    // then drops the only payload because searchCapture does not exist yet.
    const tab = await chrome.tabs.create({
        url: 'about:blank',
        active: true
    });

    searchCapture = {
        tabId: tab.id,
        returnTabId: activeTab?.id || null,
        queue: [],
        resolver: null,
        seenUrls: new Set(),
        oldestCollectedMs: null, // drives the overlay's date-based progress %
        resumeScanned: 0
    };

    try {
        await chrome.tabs.update(tab.id, {
            url: buildSearchTimelinePageUrl(rawQuery)
        });
    } catch (_) {
        await closeSearchCaptureTab();
        throw new Error('SEARCH_CAPTURE_TIMEOUT');
    }

    setTimeout(() => {
        sendSearchCaptureStatus({ phaseKey: 'preparing' }, 8);
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

// The search page went quiet while we still hold a cursor — X's timeline is
// stalled (soft rate limit / "Something went wrong"). Pause with an amber
// countdown on the overlay and retry a few times; each scroll ping also clicks
// X's Retry button. Returns the recovered payload, or null to give up.
async function recoverStalledSearchCapture(rounds = 3, waitMs = 60000) {
    for (let round = 0; round < rounds; round++) {
        if (!currentExport?.running || !searchCapture) return null;
        lastTransientStatus = {
            running: true,
            status: 'cooldown',
            duration: waitMs,
            until: Date.now() + waitMs,
            kind: 'window',
            reason: 'Search timeline stalled (likely rate-limited)'
        };
        broadcastStatus(lastTransientStatus);
        await sendSearchCaptureStatus({ pauseUntil: Date.now() + waitMs });
        await swSleep(waitMs);
        if (!currentExport?.running || !searchCapture) return null;
        await sendSearchCaptureStatus({ phaseKey: 'scrolling' });
        const payload = await requestNextSearchCapturePayload();
        if (payload) return payload;
    }
    return null;
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

// How far through the date-range export we are, in percent (null = unknown).
// Two independent signals, whichever is further along wins: items vs the
// quantity limit, and — since the live search feed runs newest → oldest —
// how deep into the requested date window the oldest collected post sits.
function computeSearchCaptureProgress() {
    if (!currentExport) return null;
    let pct = null;

    const limit = Number(currentExport.settings?.quantityLimit || 0);
    if (limit > 0) {
        pct = Math.min(100, ((currentExport.tweetCount || 0) / limit) * 100);
    }

    const datePct = computeDateCoveragePct();
    if (datePct !== null) {
        pct = (pct === null) ? datePct : Math.max(pct, datePct);
    }

    return pct === null ? null : Math.round(pct);
}

function toEpochMs(value) {
    if (!value) return NaN;
    const ms = (value instanceof Date) ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : NaN;
}

async function sendSearchCaptureStatus(overrides = {}, attempts = 1) {
    if (!searchCapture?.tabId || !currentExport) return false;

    const i18n = await getOverlayI18n();
    const { phaseKey, ...rest } = overrides;

    const message = {
        type: 'XPORTER_SEARCH_CAPTURE_STATUS',
        username: currentExport.username,
        tweetCount: currentExport.tweetCount || 0,
        quantityLimit: currentExport.settings?.quantityLimit || 0,
        dateFrom: currentExport.dateFrom ? formatDateForSearch(currentExport.dateFrom) : '',
        dateTo: currentExport.dateTo ? formatDateForSearch(currentExport.dateTo) : '',
        progressPct: computeSearchCaptureProgress(),
        // ≥95% of the date window collected → the overlay tells the user the
        // rest is almost certainly a posting gap, and highlights Stop.
        almostDone: (computeDateCoveragePct() ?? 0) >= 95,
        i18n,
        ...rest
    };
    if (phaseKey) {
        const effectivePhase = currentExport.dateResume && phaseKey !== 'preparing'
            ? 'resuming'
            : phaseKey;
        message.phase = overlayPhase(
            i18n,
            effectivePhase,
            currentExport.username,
            searchCapture?.resumeScanned || 0
        );
    }

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

    if (message.operationName !== 'SearchTimeline' ||
        typeof message.bodyText !== 'string' ||
        !message.url) {
        return { ignored: true };
    }

    const status = Number(message.status) || 200;
    // Error responses must remain retryable: the successful retry uses the
    // same cursor URL. Successful payloads are deduplicated until parsing says
    // they were malformed and explicitly removes the URL from this set.
    if (status >= 200 && status < 300) {
        if (searchCapture.seenUrls.has(message.url)) {
            return { duplicate: true };
        }
        searchCapture.seenUrls.add(message.url);
    }

    const payload = {
        url: message.url,
        bodyText: message.bodyText,
        status
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
    let noProgressPages = 0;
    const seenIds = new Set();
    await preloadSeenIds(seenIds);
    const recentIds = createRecentIdTracker(seenIds);
    const includeAboutDetails = currentExport.settings?.includeAboutAccountDetails === true;
    if (includeAboutDetails) {
        aboutAccountCache = await XPorterStorage.loadAboutAccountCache();
        if (!aboutRateLimiter) {
            aboutRateLimiter = createRateLimiter(currentExport.settings, 'about_account');
            aboutRateLimiter.onStatusChange((event) => {
                lastTransientStatus = {
                    ...event,
                    exportMode: currentExport.exportMode,
                    tweetCount: currentExport.tweetCount,
                    expectedTweets: getExpectedItemCount(),
                    quantityLimit: currentExport.settings?.quantityLimit || 0
                };
                broadcastStatus(lastTransientStatus);
            });
        }
    }

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
        if (quantityLimitReached()) {
            currentExport.completionReason = 'limit_reached';
            break;
        }

        const requestCursor = currentExport.cursor;
        const result = await rateLimiter.executeWithRateLimit(async () => {
            return await fetchFn(
                currentExport.userId,
                requestCursor
            );
        });
        if (!currentExport.running) break;

        const users = Array.isArray(result.users) ? result.users : [];
        const countBeforePage = currentExport.tweetCount;
        const expectedListCount = getExpectedItemCount();
        const unexpectedInitialEmpty = users.length === 0 &&
            currentExport.tweetCount === 0 &&
            !currentExport.cursor &&
            expectedListCount !== 0;

        if (users.length === 0) {
            emptyPages++;
            // A profile lookup just told us rows exist, so an empty first page
            // is not a successful zero-row export. Retry the same initial page
            // a few times through the normal pacing path; otherwise one empty
            // or malformed REST response becomes a green "complete" state.
            if (unexpectedInitialEmpty && emptyPages >= 3) {
                throw new Error('MAX_RETRIES_EXCEEDED');
            }
            if (emptyPages >= 3) {
                hasMore = false;
                break;
            }
        } else {
            emptyPages = 0;
        }

        // Select the rows first so detailed mode can enrich one paced batch at
        // a time without changing the original order or quantity semantics.
        const acceptedUsers = [];
        for (const user of users) {
            if (!recentIds.add(user.id)) continue;
            const quantityLimit = Number(currentExport.settings?.quantityLimit) || 0;
            if (quantityLimit > 0 &&
                currentExport.tweetCount + acceptedUsers.length >= quantityLimit) {
                hasMore = false;
                break;
            }
            acceptedUsers.push(user);
        }

        if (includeAboutDetails) {
            await enrichUsersWithAboutDetails(acceptedUsers, async (finishedBatch) => {
                await appendUsersToExport(finishedBatch);
                if (!currentExport.running) return;

                // Count every finished About batch immediately. A page can
                // contain ~100 users and Turtle intentionally handles them one
                // at a time; waiting for the whole page kept the UI at zero
                // for minutes. appendUsersToExport still groups storage writes
                // into normal 50-row chunks, and Stop flushes the remainder.
                broadcastStatus({
                    running: true,
                    status: 'fetching',
                    username: currentExport.username,
                    tweetCount: currentExport.tweetCount,
                    expectedTweets: getExpectedItemCount(),
                    quantityLimit: currentExport.settings?.quantityLimit || 0,
                    batch: Math.max(1, aboutRateLimiter.totalRequests),
                    totalRequests: aboutRateLimiter.totalRequests,
                    exportMode: currentExport.exportMode
                });
            });
        } else {
            await appendUsersToExport(acceptedUsers);
        }

        if (quantityLimitReached()) {
            hasMore = false;
            currentExport.completionReason = 'limit_reached';
        }

        const acceptedNew = currentExport.tweetCount - countBeforePage;
        const cursorAdvanced = !!result.nextCursor && result.nextCursor !== requestCursor;
        noProgressPages = (acceptedNew > 0 || cursorAdvanced) ? 0 : (noProgressPages + 1);

        // Update cursor
        if (hasMore && cursorAdvanced) {
            currentExport.cursor = result.nextCursor;
        } else if (hasMore && !unexpectedInitialEmpty &&
            (!result.nextCursor || noProgressPages >= 3)) {
            currentExport.completionReason = 'source_exhausted';
            currentExport.cursor = null;
            hasMore = false;
        }

        // Buffer first, then the advanced cursor — see _fetchPostsLoop.
        await flushExportBuffer();
        if (includeAboutDetails) {
            const cached = await XPorterStorage.saveAboutAccountCache(aboutAccountCache);
            if (!cached) XLog.warn('Could not persist About this Account cache');
        }
        await saveCurrentState();

        const expectedCount = getExpectedItemCount();

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
    if (currentExport.running && !currentExport.completionReason) {
        currentExport.completionReason = quantityLimitReached()
            ? 'limit_reached'
            : 'source_exhausted';
        if (currentExport.completionReason === 'source_exhausted') {
            currentExport.cursor = null;
        }
    }
}

async function appendUsersToExport(users) {
    for (const user of users) {
        if (!currentExport.running) break;
        currentExport.tweetBuffer.push(user);
        currentExport.tweetCount++;
        recordFirstItemOnce();

        if (currentExport.tweetBuffer.length >= XPorterStorage.MAX_TWEETS_PER_BATCH) {
            await flushExportBuffer();
        }
    }
}

function aboutDetailsForUser(about = {}) {
    return {
        account_based_in: about.accountBasedIn || '',
        account_location_accurate: typeof about.locationAccurate === 'boolean'
            ? about.locationAccurate
            : '',
        premium_since: about.premiumSince || '',
        account_source: about.accountSource || '',
        affiliate_username: about.affiliateUsername || '',
        username_change_count: about.usernameChangeCount ?? '',
        username_last_changed_at: about.usernameLastChangedAt || ''
    };
}

function resolveAboutAccountBatchSize(settings = {}) {
    const presets = XPORTER_CONFIG.ABOUT_ACCOUNT_BATCH_SIZES || {
        turtle: 1,
        careful: 3,
        standard: 5,
        fast: 10,
        turbo: 20
    };
    const speed = settings.aboutAccountSpeed || 'standard';
    if (speed !== 'custom') return presets[speed] || presets.standard || 5;

    const [min, max, fallback] =
        XPORTER_CONFIG.ABOUT_ACCOUNT_CUSTOM_BATCH_RANGE || [1, 50, 5];
    const requested = Number.parseInt(settings.aboutAccountCustomBatchSize, 10);
    const value = Number.isFinite(requested) ? requested : fallback;
    return Math.max(min, Math.min(max, value));
}

async function enrichUsersWithAboutDetails(users, onBatch = null) {
    const enriched = [];

    for (let start = 0; start < users.length;) {
        if (!currentExport.running) break;
        const batchSize = resolveAboutAccountBatchSize(currentExport.settings);
        const batch = users.slice(start, start + batchSize);
        const batchResults = await aboutRateLimiter.executeWithRateLimit(async () => {
            const settled = await Promise.allSettled(
                batch.map(user => enrichUserWithAboutDetails(user))
            );
            const terminalFailure = settled.find(result =>
                result.status === 'rejected' &&
                ['RATE_LIMITED', 'ABORTED'].includes(result.reason?.message)
            );
            if (terminalFailure) throw terminalFailure.reason;
            return settled.map((result, index) => result.status === 'fulfilled'
                ? result.value
                : { ...batch[index], ...aboutDetailsForUser() });
        });
        enriched.push(...batchResults);
        if (onBatch) await onBatch(batchResults);
        start += batch.length;
    }

    return enriched;
}

async function enrichUserWithAboutDetails(user) {
    const key = String(user?.id || user?.username || '').toLowerCase();
    const cached = key ? aboutAccountCache?.[key] : null;
    if (cached?.data) return { ...user, ...aboutDetailsForUser(cached.data) };

    let about = {};
    let failed = false;
    try {
        about = await XPorterAPI.getAccountAbout(user.username);
    } catch (error) {
        if (['ABORTED', 'RATE_LIMITED'].includes(error.message)) throw error;
        failed = true;
        XLog.warn(`About this Account unavailable for @${user.username}:`, error.message);
    }

    if (key) {
        aboutAccountCache[key] = {
            cachedAt: Date.now(),
            failed,
            data: about
        };
    }
    return { ...user, ...aboutDetailsForUser(about) };
}

// ==================== Stop / Resume / Status ====================

async function stopExport() {
    // Only signal the loop — it does the single flush + persist + broadcast in
    // its own !running / ABORTED branches. Flushing here too raced the loop's
    // in-flight saveTweetBatch (double-written batch, gap in the indices).
    if (currentExport?.running) {
        currentExport.running = false;
    }
    if (rateLimiter) {
        rateLimiter.abort();
    }
    if (aboutRateLimiter) {
        aboutRateLimiter.abort();
    }
    XPorterAPI.abortActiveRequests?.();
    await closeSearchCaptureTab();
    // Acknowledge only after the loop exits, so a Resume/Start issued right
    // after this response can't collide with the unwinding loop.
    await waitForLoopUnwind();
    return { success: true };
}

async function resumeExport(extraItems) {
    await waitForLoopUnwind();
    if (exportStarting || exportLoopPromise || (currentExport && currentExport.running)) {
        return { error: 'ALREADY_RUNNING' };
    }
    exportStarting = true;
    try {
        return await _resumeExportInner(extraItems);
    } finally {
        exportStarting = false;
    }
}

function canFallbackWithoutReplies(state) {
    return !!state &&
        state.running === false &&
        state.status === 'error' &&
        state.error === 'REPLIES_UNAVAILABLE' &&
        state.exportMode === 'posts' &&
        (state.tweetCount || 0) === 0 &&
        !!state.userId &&
        state.settings?.includeReplies === true;
}

async function resumePostsOnly() {
    await waitForLoopUnwind();
    if (exportStarting || exportLoopPromise || (currentExport && currentExport.running)) {
        return { error: 'ALREADY_RUNNING' };
    }
    exportStarting = true;
    try {
        return await _resumeExportInner(undefined, { postsOnlyFallback: true });
    } finally {
        exportStarting = false;
    }
}

// Settings that only control request pacing, never the shape of the data.
const PACING_SETTING_KEYS = [
    'exportSpeed', 'customDelaySec', 'customBatchSize', 'customCooldownMin',
    'userExportSpeed', 'userCustomDelaySec', 'userCustomBatchSize', 'userCustomCooldownMin',
    'aboutAccountSpeed', 'aboutAccountCustomBatchSize', 'aboutAccountMaxRetries',
    'adaptivePacing', 'requestDelay', 'batchSize', 'cooldownDuration'
];

function applyLivePacingSettings(settingsPatch = {}) {
    if (!currentExport?.running || !currentExport.settings) return false;

    let changed = false;
    for (const key of PACING_SETTING_KEYS) {
        if (!Object.hasOwn(settingsPatch, key)) continue;
        if (currentExport.settings[key] === settingsPatch[key]) continue;
        currentExport.settings[key] = settingsPatch[key];
        changed = true;
    }
    if (!changed) return false;

    // Reconfigure in place: an in-flight request/wait finishes under the old
    // preset, while the next request uses the new one. Replacing or aborting
    // the limiter here would lose counters or turn a harmless settings change
    // into a failed export.
    rateLimiter?.reconfigure?.(
        buildRateLimiterOptions(currentExport.settings, currentExport.exportMode)
    );
    aboutRateLimiter?.reconfigure?.(
        buildRateLimiterOptions(currentExport.settings, 'about_account')
    );
    return true;
}

// Resume with the same FILTERS that produced the saved rows (the export
// snapshot; changing includeRetweets mid-export would make one half of the
// file contradict the other), but with the user's CURRENT pacing: switching
// to a slower speed is the natural escape hatch after rate limits, and a
// snapshot that silently ignored it would trap the export at the old pace.
// Merging on top of stored defaults keeps states from before snapshots
// were persisted working.
function buildResumeSettings(storedSettings, snapshot) {
    const settings = { ...storedSettings, ...(snapshot || {}) };
    for (const key of PACING_SETTING_KEYS) {
        if (storedSettings[key] !== undefined) settings[key] = storedSettings[key];
    }
    return settings;
}

async function _resumeExportInner(extraItems, { postsOnlyFallback = false } = {}) {
    const savedState = await XPorterStorage.loadExportState();
    if (!savedState) {
        return { error: 'No export to resume' };
    }
    if (postsOnlyFallback && !canFallbackWithoutReplies(savedState)) {
        return { error: 'REPLIES_UNAVAILABLE' };
    }

    const storedSettings = await XPorterStorage.loadSettings();
    const settings = buildResumeSettings(storedSettings, savedState.settings);
    if (postsOnlyFallback) settings.includeReplies = false;

    // "+N more" resumes raise the limit for THIS export only, by overriding
    // the per-export settings snapshot — the stored quantityLimit setting is
    // never touched. (The popup used to SAVE_SETTINGS the bumped value, which
    // permanently rewrote the user's configured limit on every resume.)
    // The override persists with the export state so it survives a SW death.
    const extra = parseInt(extraItems, 10);
    let limitOverride = savedState.limitOverride || 0;
    const canExtendCompletedExport = savedState.status === 'complete' &&
        savedState.completionReason !== 'source_exhausted';
    if (canExtendCompletedExport && Number.isFinite(extra) && extra > 0) {
        limitOverride = (savedState.tweetCount || 0) + extra;
    }
    if (limitOverride > 0) {
        settings.quantityLimit = limitOverride;
    }

    rateLimiter = createRateLimiter(settings, savedState.exportMode || 'posts');
    aboutRateLimiter = null;
    aboutAccountCache = null;
    lastTransientStatus = null;
    // Restore request counters so the batch/cooldown rhythm and the "batch N"
    // indicator stay accurate after resuming (previously reset to zero).
    if (!postsOnlyFallback) {
        rateLimiter.restoreState(savedState.rateLimiterState);
    }

    rateLimiter.onStatusChange((event) => {
        lastTransientStatus = event;
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
        itemsRecordedBase: savedState.tweetCount || 0,
        totalBatches: savedState.totalBatches || 0,
        tweetBuffer: [],
        userId: savedState.userId,
        userInfo: savedState.userInfo,
        cursor: postsOnlyFallback ? null : savedState.cursor,
        startedAt: savedState.startedAt,
        status: 'fetching',
        limitOverride: limitOverride || 0,
        dateResume: !!(savedState.dateFrom || savedState.dateTo),
        completionReason: null,
        partialReason: postsOnlyFallback
            ? 'replies_unavailable'
            : (savedState.partialReason || null)
    };

    // Persist the raised per-export limit and running state before the loop can
    // enter a long rate-limit wait or be terminated by Chrome.
    try {
        await saveCurrentState();
    } catch (error) {
        currentExport = null;
        rateLimiter = null;
        return { error: error.message };
    }

    // Enqueue the per-run usage reset before the loop can collect its first
    // resumed item. This keeps first_item_ms tied to this resume attempt.
    XPorterStorage.recordExportStart(currentExport.exportMode, currentExport.outputFormat, {
        resume: true,
        dateRange: !!(currentExport.dateFrom || currentExport.dateTo)
    }).then(XPorterFeedback.refresh).catch(() => {});
    _lastRecordedUsagePhase = 'fetching';

    launchExportLoop('Resume export error:');

    return {
        success: true,
        status: 'resumed',
        tweetCount: currentExport.tweetCount,
        partialReason: currentExport.partialReason
    };
}

async function getExportStatus() {
    // Expiration must also run while a terminal export is still held in this
    // live worker. Previously it only ran after currentExport became null, so
    // a long-lived worker could retain "auto-cleared" data indefinitely.
    let savedSettings = null;
    if (!currentExport?.running) {
        savedSettings = await applyAutoExpiration();
    }

    if (currentExport) {
        const waitUntil = Math.max(
            rateLimiter?.waitUntil || 0,
            aboutRateLimiter?.waitUntil || 0,
            manualWaitUntil || 0
        ) || null;
        const transientStatus = lastTransientStatus?.status;
        const transientIsActive = waitUntil > Date.now() ||
            transientStatus === 'retrying' ||
            transientStatus === 'rate_limited';
        const transient = currentExport.running && transientIsActive && lastTransientStatus
            ? {
                ...lastTransientStatus,
                until: waitUntil,
                ...(lastTransientStatus.retryIn
                    ? { retryIn: Math.max(0, waitUntil - Date.now()) }
                    : {})
            }
            : {};
        return {
            running: currentExport.running,
            status: currentExport.status,
            username: currentExport.username,
            tweetCount: currentExport.tweetCount,
            expectedTweets: getExpectedItemCount(currentExport),
            quantityLimit: currentExport.settings?.quantityLimit || 0,
            error: currentExport.error || null,
            startedAt: currentExport.startedAt,
            completedAt: currentExport.completedAt,
            userInfo: currentExport.userInfo,
            exportMode: currentExport.exportMode,
            outputFormat: currentExport.outputFormat,
            partialReason: currentExport.partialReason || null,
            completionReason: currentExport.completionReason || null,
            until: waitUntil,
            canResume: !currentExport.running &&
                (currentExport.status === 'stopped' || currentExport.status === 'error') &&
                !!currentExport.userId,
            canFallbackWithoutReplies: canFallbackWithoutReplies(currentExport),
            ...transient
        };
    }

    // Check saved state
    if (!savedSettings) savedSettings = await applyAutoExpiration();
    const savedState = await XPorterStorage.loadExportState();
    if (savedState) {
        // A persisted running=true with no in-memory export means Chrome killed
        // the SW mid-export (sleep, crash, update). Repair it to a resumable
        // 'stopped' — otherwise the UI shows a phantom in-progress export with
        // neither Resume nor Download, forever.
        if (savedState.running) {
            savedState.running = false;
            savedState.status = 'stopped';
            await XPorterStorage.saveExportState(savedState);
        }

        return {
            running: false,
            status: savedState.status,
            username: savedState.username,
            tweetCount: savedState.tweetCount || 0,
            expectedTweets: getExpectedItemCount(savedState),
            quantityLimit: savedState.limitOverride > 0
                ? savedState.limitOverride
                : (savedState.settings?.quantityLimit ?? savedSettings?.quantityLimit ?? 0),
            error: savedState.error || null,
            startedAt: savedState.startedAt,
            completedAt: savedState.completedAt,
            userInfo: savedState.userInfo,
            exportMode: savedState.exportMode,
            outputFormat: savedState.outputFormat,
            partialReason: savedState.partialReason || null,
            completionReason: savedState.completionReason || null,
            canResume: (savedState.status === 'stopped' || savedState.status === 'error') && !!savedState.userId,
            canFallbackWithoutReplies: canFallbackWithoutReplies(savedState)
        };
    }

    return { running: false, status: 'idle' };
}

// ==================== Helpers ====================

async function saveCurrentState({ bestEffort = false } = {}) {
    if (!currentExport) return;

    const saved = await XPorterStorage.saveExportState({
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
        limitOverride: currentExport.limitOverride || 0,
        partialReason: currentExport.partialReason || null,
        completionReason: currentExport.completionReason || null,
        settings: { ...currentExport.settings },
        rateLimiterState: rateLimiter?.getState() || null
    });
    if (!saved && !bestEffort) throw new Error('STORAGE_FULL');
    return saved;
}

async function applyAutoExpiration() {
    const settings = await XPorterStorage.loadSettings();
    if (settings.autoExpireEnabled === false) return settings;

    const maxAge = Math.max(1, Number(settings.autoExpireHours) || 4) * 60 * 60 * 1000;
    const state = currentExport?.running ? null : await XPorterStorage.loadExportState();
    if (state?.updatedAt && Date.now() - state.updatedAt > maxAge) {
        await XPorterStorage.clearExportState();
        if (currentExport && !currentExport.running) currentExport = null;
    }
    await XPorterStorage.pruneExpiredExportHistory(settings);
    return settings;
}

// Cancellable sleep for waits outside RateLimitManager. Check the export flag
// every second so Stop does not leave a date-range export sleeping for a minute;
// touch an extension API every 20 seconds to keep the MV3 worker alive.
async function swSleep(ms) {
    manualWaitUntil = Date.now() + ms;
    let nextKeepAlive = Date.now() + 20000;
    try {
        while (Date.now() < manualWaitUntil) {
            if (!currentExport?.running) return;
            const step = Math.min(1000, manualWaitUntil - Date.now());
            await new Promise(resolve => setTimeout(resolve, step));
            if (Date.now() >= nextKeepAlive) {
                try { await chrome.runtime.getPlatformInfo(); } catch (_) { /* keepalive only */ }
                nextKeepAlive = Date.now() + 20000;
            }
        }
    } finally {
        manualWaitUntil = null;
    }
}

// ==================== Toolbar badge ====================
// The popup closes on any outside click, and churn rows show people start an
// export, lose the popup, see no sign of life and uninstall minutes later.
// The badge keeps the export visibly alive on the toolbar icon: live item
// count while running, ✓ / ! / II when it ends. A terminal badge is cleared
// as soon as a UI shows the final state (GET_STATUS with running:false).
const BADGE_COLORS = { run: '#1d9bf0', ok: '#00ba7c', err: '#f4212e', stop: '#e2b203' };

function formatBadgeCount(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1000) return String(n);
    if (n < 10000) return (Math.floor(n / 100) / 10) + 'k'; // 1.2k
    return Math.floor(n / 1000) + 'k';                      // 12k (badge fits 4 chars)
}

function setBadge(text, color) {
    try {
        chrome.action.setBadgeText({ text });
        if (color) chrome.action.setBadgeBackgroundColor({ color });
    } catch (_) { /* badge is best-effort */ }
}

function updateBadgeForStatus(event) {
    switch (event.status) {
        case 'resolving_user':
            setBadge('…', BADGE_COLORS.run);
            break;
        case 'fetching':
        case 'cooldown':
        case 'rate_limited':
        case 'retrying':
            setBadge(formatBadgeCount(currentExport?.tweetCount) || '…', BADGE_COLORS.run);
            break;
        case 'error':
            // Transient retry errors (retryIn set, still running) keep the
            // running badge — only a dead export earns the red mark.
            if (event.running === false) {
                setBadge('!', BADGE_COLORS.err);
            }
            break;
        case 'complete':
            setBadge('✓', BADGE_COLORS.ok);
            break;
        case 'stopped':
            setBadge('II', BADGE_COLORS.stop);
            break;
    }
}

function broadcastStatus(event) {
    if (!chrome.runtime?.id) return;
    if (event.status === 'cooldown' ||
        event.status === 'rate_limited' ||
        event.status === 'retrying') {
        recordUsagePhase('rate_limit');
    } else if (event.status === 'fetching') {
        recordUsagePhase('fetching');
    }
    updateBadgeForStatus(event);
    chrome.runtime.sendMessage({
        type: 'EXPORT_STATUS_UPDATE',
        exportMode: currentExport?.exportMode,
        outputFormat: currentExport?.outputFormat,
        username: currentExport?.username,
        startedAt: currentExport?.startedAt,
        partialReason: currentExport?.partialReason || null,
        completionReason: currentExport?.completionReason || null,
        ...event
    }).catch(() => {
        // No listeners — that's fine
    });
}

function launchExportLoop(logPrefix) {
    const exportInstance = currentExport;
    const tracked = runExportLoop()
        .catch(async (err) => {
            XLog.error(logPrefix, err.message);
            // A newer export must never be mutated by a late rejection from an
            // older loop. The loop guard normally prevents that replacement;
            // this identity check is the final safety net.
            if (!currentExport || currentExport !== exportInstance) return;

            // The user already pressed Stop — a late failure from the aborted
            // in-flight request must land as the 'stopped' they asked for,
            // not overwrite it with a scary terminal error.
            if ((rateLimiter?._aborted || aboutRateLimiter?._aborted) &&
                currentExport.running === false) {
                currentExport.status = 'stopped';
                await saveCurrentState({ bestEffort: true });
                recordExportStoppedOnce();
                broadcastStopped();
                return;
            }

            currentExport.running = false;
            currentExport.status = 'error';
            currentExport.error = err.message.startsWith('API_ERROR_400') ? 'STALE_QUERY_ID' : err.message;
            await saveCurrentState({ bestEffort: true });
            broadcastStatus({
                running: false,
                status: 'error',
                error: currentExport.error,
                tweetCount: currentExport.tweetCount,
                canResume: !!currentExport.userId,
                canFallbackWithoutReplies: canFallbackWithoutReplies(currentExport)
            });
            XPorterStorage.recordExportError(currentExport.error).then(XPorterFeedback.refresh).catch(() => {});
        })
        .finally(() => {
            if (exportLoopPromise === tracked) exportLoopPromise = null;
        });
    exportLoopPromise = tracked;
}

// A single stop can otherwise be reported up to three times (stopExport, the
// loop's !running branch, and the ABORTED catch). Broadcast 'stopped' just once
// per export instance — the flag lives on currentExport, which is rebuilt fresh
// on every start/resume, so it resets naturally.
function broadcastStopped() {
    if (!currentExport || currentExport._stoppedSent) return;
    currentExport._stoppedSent = true;
    broadcastStatus({
        running: false,
        status: 'stopped',
        tweetCount: currentExport.tweetCount,
        canResume: !!currentExport.userId,
        exportMode: currentExport.exportMode
    });
}

function recordExportStoppedOnce() {
    if (!currentExport || currentExport._stopRecorded) return;
    currentExport._stopRecorded = true;
    XPorterStorage.recordExportStopped().then(XPorterFeedback.refresh).catch(() => {});
}

let _lastRecordedUsagePhase = '';

function recordUsagePhase(phase) {
    if (_lastRecordedUsagePhase === phase) return;
    _lastRecordedUsagePhase = phase;
    XPorterStorage.recordExportPhase(phase).then(XPorterFeedback.refresh).catch(() => {});
}

function recordFirstItemOnce() {
    // tweetCount can already be > 0 on Resume; this flag belongs to the newly
    // constructed in-memory run, so the first NEW row still records latency.
    if (!currentExport || currentExport._firstItemRecorded) return;
    currentExport._firstItemRecorded = true;
    XPorterStorage.recordFirstItem().then(XPorterFeedback.refresh).catch(() => {});
}

// ==================== Auto-Resume on Startup ====================

chrome.runtime.onStartup.addListener(async () => {
    const state = await XPorterStorage.loadExportState();
    if (state && state.running) {
        XLog.log('Resuming interrupted export...');
        state.running = false;
        state.status = 'stopped';
        await XPorterStorage.saveExportState(state);
        // The pre-restart badge still shows a live count — reflect reality:
        // the export survived as a resumable 'stopped', not as running.
        setBadge('II', BADGE_COLORS.stop);
    } else {
        setBadge(''); // don't carry a stale badge into a fresh session
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
            includeReplies: false,
            includeArticles: true,
            includeAboutAccountDetails: false,
            aboutAccountSpeed: 'standard',
            aboutAccountCustomBatchSize: 5,
            aboutAccountMaxRetries: 5,
            quantityLimit: 500,
            requestDelay: 3000,
            exportSpeed: 'standard',
            customDelaySec: 5,
            customBatchSize: 20,
            customCooldownMin: 3,
            userExportSpeed: 'standard',
            userCustomDelaySec: 5,
            userCustomBatchSize: 20,
            userCustomCooldownMin: 3,
            batchSize: 20,
            cooldownDuration: 180000,
            adaptivePacing: true,
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
