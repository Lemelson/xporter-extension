// XPorter — Background Service Worker
// Orchestrates the export process, handles messages from popup/export page

// Import utility scripts (paths relative to this service worker's location)
importScripts(
    '../utils/config.js',
    '../utils/api-features.js',
    '../utils/api.js',
    '../utils/rateLimit.js',
    '../utils/columns-i18n.js',
    '../utils/csv.js',
    '../utils/storage.js',
    '../utils/post-database.js',
    '../popup/i18n.js' // loadTranslations() — used to localize the in-page capture overlay
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
let searchCapture = null;
let exportLoopPromise = null;
let lastTransientStatus = null;
let manualWaitUntil = null;

const RATE_LIMIT_KEYS_BY_MODE = {
    posts: 'UserTweets',
    followers: 'Followers',
    following: 'Following',
    verified_followers: 'BlueVerifiedFollowers'
};

// Operations whose live-captured queryIds we accept from the content script.
const VALID_LIVE_OPERATIONS = new Set([
    'UserByScreenName',
    'UserTweets',
    'Followers',
    'Following',
    'BlueVerifiedFollowers',
    'SearchTimeline'
]);

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

// Build the effective pacing preset for the given settings. Named presets come
// from XPORTER_CONFIG.SPEED_PRESETS; 'custom' is assembled from the user's own
// numbers and honors the batch rhythm unconditionally (alwaysBatchCooldown).
function resolveSpeedPreset(settings) {
    const presets = XPORTER_CONFIG.SPEED_PRESETS || {};
    if (settings.exportSpeed === 'custom') {
        const L = XPORTER_CONFIG.CUSTOM_SPEED_LIMITS || {};
        const delayMs = clampCustomSpeed(settings.customDelaySec, L.delaySec) * 1000;
        return {
            adaptiveFloor: delayMs,
            adaptivePad: 1000,
            budgetFraction: 1,
            // The user picked an explicit pace — hold it while X's budget
            // lasts, then wait out the window reset (racing preset).
            raceReserve: 2,
            batchSize: clampCustomSpeed(settings.customBatchSize, L.batch),
            cooldownDuration: clampCustomSpeed(settings.customCooldownMin, L.cooldownMin) * 60000,
            alwaysBatchCooldown: true,
            // Headerless fallback also runs at the user's chosen pace.
            customFallbackDelays: [delayMs, delayMs + 2000]
        };
    }
    return presets[settings.exportSpeed] || presets.standard || {};
}

function createRateLimiter(settings, mode) {
    const adaptivePacing = settings.adaptivePacing !== false;
    // Export Speed preset — the one user-facing pacing knob. Everything else
    // (floors, pads, fallback delays, batch rhythm) is derived from it.
    const preset = resolveSpeedPreset(settings);
    const configuredFallback = adaptivePacing
        ? (preset.customFallbackDelays || XPORTER_CONFIG.FALLBACK_REQUEST_DELAYS?.[mode])
        : null;
    const scale = preset.fallbackScale || 1;
    const fallbackMinDelay = Math.round((configuredFallback?.[0] || settings.requestDelay) * scale);
    const fallbackMaxDelay = Math.round((configuredFallback?.[1] || fallbackMinDelay / scale) * scale);
    const endpointKey = RATE_LIMIT_KEYS_BY_MODE[mode];

    return new RateLimitManager({
        requestDelay: settings.requestDelay,
        batchSize: preset.batchSize || settings.batchSize,
        cooldownDuration: preset.cooldownDuration || settings.cooldownDuration,
        adaptiveFloor: preset.adaptiveFloor,
        adaptivePad: preset.adaptivePad,
        budgetFraction: preset.budgetFraction,
        raceReserve: preset.raceReserve,
        alwaysBatchCooldown: preset.alwaysBatchCooldown,
        adaptivePacing,
        fallbackMinDelay,
        fallbackMaxDelay,
        rateLimitProvider: () => (
            endpointKey && typeof XPorterAPI?.getRateLimit === 'function'
                ? XPorterAPI.getRateLimit(endpointKey)
                : null
        )
    });
}

// ==================== Uninstall feedback ====================
// When the user removes XPorter, Chrome opens this page in a new tab. We append an
// anonymous, non-personal usage snapshot (version, install age, language, theme,
// per-mode/format counts, success/error totals, a few settings) so the feedback
// form can ask the right follow-up and so churn can be understood.
// NO X data, no usernames, nothing identifying is ever sent. Disclosed in the
// privacy policy. EDIT this if your GitHub Pages URL differs.
const FEEDBACK_URL_BASE = 'https://lemelson.github.io/xporter/feedback.html';

let _lastUninstallRefresh = 0;

// Throttled wrapper: high-frequency callers (active-time ticks) use this so we
// don't rebuild the URL every few seconds. `force` bypasses the throttle.
function maybeRefreshUninstallURL(force) {
    const now = Date.now();
    if (force || now - _lastUninstallRefresh > 20000) {
        refreshUninstallURL();
    }
}

async function refreshUninstallURL() {
    _lastUninstallRefresh = Date.now();
    try {
        const [settings, usage] = await Promise.all([
            XPorterStorage.loadSettings(),
            XPorterStorage.loadUsage()
        ]);
        const now = Date.now();
        const days = usage.installedAt ? Math.floor((now - usage.installedAt) / 86400000) : '';
        const lastDays = usage.lastExportAt ? Math.floor((now - usage.lastExportAt) / 86400000) : '';
        let lang = settings.language;
        if (!lang && typeof detectBrowserLanguage === 'function') {
            try { lang = detectBrowserLanguage(); } catch (_) { /* ignore */ }
        }
        // Operating system (win | mac | linux | cros | …) so churn can be sliced
        // by platform without parsing the User-Agent.
        let os = '';
        try {
            const pi = await chrome.runtime.getPlatformInfo();
            os = (pi && pi.os) || '';
        } catch (_) { /* ignore */ }
        const m = usage.byMode || {};
        const f = usage.byFormat || {};
        const p = {
            src: 'uninstall',
            v: chrome.runtime.getManifest().version,
            os,
            days,
            installed_at: usage.installedAt ? new Date(usage.installedAt).toISOString() : '',
            ui_lang: lang || 'en',
            theme: settings.theme || '',
            opens: usage.opens || 0,
            active_s: Math.round((usage.activeMs || 0) / 1000),
            exp_started: usage.exportsStarted || 0,
            exp_ok: usage.exportsOk || 0,
            exp_err: usage.exportsErr || 0,
            exp_stopped: usage.exportsStopped || 0,
            m_posts: m.posts || 0,
            m_followers: m.followers || 0,
            m_following: m.following || 0,
            m_verified: m.verifiedFollowers || 0,
            m_dates: usage.dateRangeExports || 0,
            resumes: usage.resumes || 0,
            dl: usage.downloads || 0,
            f_csv: f.csv || 0,
            f_json: f.json || 0,
            f_xlsx: f.xlsx || 0,
            items: usage.itemsTotal || 0,
            last_days: lastDays,
            last_err: usage.lastError || '',
            s_retweets: settings.includeRetweets ? 1 : 0,
            s_replies: settings.includeReplies ? 1 : 0,
            s_articles: settings.includeArticles !== false ? 1 : 0,
            s_limit: settings.quantityLimit,
            s_localize: settings.localizeExportHeaders ? 1 : 0,
            // Speed preset; for custom, inline the user's own pacing numbers
            // (delay sec / cooldown min / batch size) so churn can be sliced
            // by how aggressively people were hitting X.
            s_speed: settings.exportSpeed === 'custom'
                ? `custom_${settings.customDelaySec || 0}_${settings.customCooldownMin || 0}_${settings.customBatchSize || 0}`
                : (settings.exportSpeed || 'standard'),
            s_adaptive: settings.adaptivePacing !== false ? 1 : 0
        };
        if (usage.installedAtApprox) p.inst_approx = 1;
        const qs = Object.keys(p)
            .filter(k => p[k] !== '' && p[k] !== undefined && p[k] !== null)
            .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(p[k]))
            .join('&');
        chrome.runtime.setUninstallURL(FEEDBACK_URL_BASE + '?' + qs);
    } catch (e) {
        // Always keep a working URL so the feedback page still opens.
        try { chrome.runtime.setUninstallURL(FEEDBACK_URL_BASE + '?src=uninstall'); } catch (_) { /* ignore */ }
    }
}

chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
        await XPorterStorage.markInstalled(chrome.runtime.getManifest().version);
    } else if (details.reason === 'update') {
        await XPorterStorage.backfillInstalledAt();
    }
    refreshUninstallURL();
});

chrome.runtime.onStartup.addListener(() => { refreshUninstallURL(); });

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
function overlayPhase(i18n, phaseKey, username) {
    const u = username || 'profile';
    switch (phaseKey) {
        case 'preparing': return `${i18n.preparingFor} @${u}...`;
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
            if (!await XPorterStorage.saveSettings(message.settings)) {
                return { error: 'STORAGE_FULL' };
            }
            _overlayI18n = null; // language may have changed — reload overlay strings lazily
            await applyAutoExpiration();
            refreshUninstallURL(); // keep language/theme/settings snapshot fresh
            return { success: true };

        case 'GET_SETTINGS':
            const settings = await XPorterStorage.loadSettings();
            return { settings };

        case 'CLEAR_EXPORT':
            if (exportLoopPromise) {
                return { error: 'ALREADY_RUNNING' };
            }
            await XPorterStorage.clearExportState();
            currentExport = null;
            return { success: true };

        case 'DISCOVERED_QUERYID':
            // Live queryId captured from X.com's own network traffic. The relay
            // channel is spoofable by any page script, so validate strictly here
            // (content.js validates too — defense in depth): known operation,
            // plausible queryId shape. Anything else is dropped silently.
            if (VALID_LIVE_OPERATIONS.has(message.operationName) &&
                typeof message.queryId === 'string' &&
                /^[A-Za-z0-9_-]{10,40}$/.test(message.queryId)) {
                XPorterAPI.setLiveQueryId(message.operationName, message.queryId);
            }
            return { success: true };

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
            return downloadFeedDatabase(message.outputFormat);

        case 'CLEAR_FEED_DB':
            await XPorterPostDB.clear();
            return { success: true };

        case 'GET_EXPORT_HISTORY':
            await applyAutoExpiration();
            const history = await XPorterStorage.loadExportHistory();
            return { history: history.map(({ items, ...entry }) => entry) };

        case 'DELETE_HISTORY_ENTRY':
            await XPorterStorage.deleteExportHistoryEntry(message.id);
            return { success: true };

        case 'CLEAR_HISTORY':
            await XPorterStorage.clearExportHistory();
            return { success: true };

        case 'XP_SESSION_OPEN':
            // Popup / export page was opened — count it and refresh the snapshot.
            await XPorterStorage.recordOpen();
            refreshUninstallURL();
            return { success: true };

        case 'XP_ACTIVE_TICK':
            // Accumulated active (visible) time in the UI. Refresh is throttled
            // unless the page is unloading (flush) so we don't churn on every tick.
            await XPorterStorage.addActiveMs(message.ms);
            maybeRefreshUninstallURL(message.flush);
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
    const normalizedDateFrom = (mode === 'posts') ? normalizeDateBoundary(dateFrom, 'start') : null;
    const normalizedDateTo = (mode === 'posts') ? normalizeDateBoundary(dateTo, 'end') : null;

    if (normalizedDateFrom && normalizedDateTo && normalizedDateFrom > normalizedDateTo) {
        return { error: 'INVALID_DATE_RANGE' };
    }

    // Initialize rate limiter with current settings. The provider lets it pace
    // adaptively from X's live x-rate-limit-* budget (fixed delay is fallback).
    rateLimiter = createRateLimiter(settings, mode);
    lastTransientStatus = null;
    _overlayI18n = null; // re-read the UI language for this export's overlay

    rateLimiter.onStatusChange((event) => {
        lastTransientStatus = event;
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
        itemsRecordedBase: 0,
        totalBatches: 0,
        tweetBuffer: [], // used for both tweets and users
        userId: null,
        cursor: null,
        startedAt: Date.now(),
        status: 'resolving_user'
    };

    // Save initial state
    await saveCurrentState();

    // Anonymous usage counter (for uninstall feedback) — fire and forget
    XPorterStorage.recordExportStart(mode, outputFormat, {
        dateRange: !!(normalizedDateFrom || normalizedDateTo)
    }).then(refreshUninstallURL).catch(() => {});

    // Start the export process (non-blocking)
    launchExportLoop('Export loop error:');

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
        const expectedCount = getExpectedItemCount();

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

        // Anonymous usage counter (for uninstall feedback) — fire and forget
        const itemsDelta = Math.max(0, currentExport.tweetCount - (currentExport.itemsRecordedBase || 0));
        XPorterStorage.recordExportComplete(itemsDelta).then(refreshUninstallURL).catch(() => {});

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

function quantityLimitReached() {
    const limit = currentExport?.settings?.quantityLimit || 0;
    return limit > 0 && currentExport.tweetCount >= limit;
}

function getExpectedItemCount(exportState = currentExport) {
    const info = exportState?.userInfo || {};
    switch (exportState?.exportMode) {
        case 'following':
            return info.followingCount || 0;
        case 'followers':
        case 'verified_followers':
            return info.followersCount || 0;
        case 'posts':
        default:
            return info.tweetCount || 0;
    }
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

    let hasMore = true;
    let emptyPages = 0;
    const seenIds = new Set();
    await preloadSeenIds(seenIds);

    while (hasMore && currentExport.running) {
        // Check quantity limit
        if (quantityLimitReached()) {
            break;
        }

        const requestCursor = currentExport.cursor;
        const result = await rateLimiter.executeWithRateLimit(async () => {
            return await XPorterAPI.fetchUserTweets(
                currentExport.userId,
                requestCursor
            );
        });
        if (!currentExport.running) break;

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

        // Process tweets. (No date filtering here: exports with a date range are
        // diverted to _fetchPostsByDateRangeLoop at the top of _fetchPostsLoop.)
        for (const tweet of (result.tweets || [])) {
            if (!currentExport.settings.includeRetweets && tweet.type === 'retweet') continue;
            if (!currentExport.settings.includeReplies && tweet.type === 'reply') continue;
            if (currentExport.settings.includeArticles === false && tweet.type === 'article') continue;

            if (seenIds.has(tweet.id)) continue;
            if (quantityLimitReached()) {
                hasMore = false;
                break;
            }
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
                await flushExportBuffer();
            }
        }

        if (quantityLimitReached()) {
            hasMore = false;
        }

        // Update cursor
        // Keep the current cursor when stopping on a quantity limit so resume
        // can refetch the same page and skip already-saved IDs.
        if (hasMore && result.nextCursor) {
            currentExport.cursor = result.nextCursor;
        } else if (hasMore) {
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
                parsedPayload = parseSearchTimelineResponse(JSON.parse(payload.bodyText));
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
                if (!currentExport.settings.includeRetweets && tweet.type === 'retweet') continue;
                if (!currentExport.settings.includeReplies && tweet.type === 'reply') continue;
                if (currentExport.settings.includeArticles === false && tweet.type === 'article') continue;
                if (seenIds.has(tweet.id)) continue;
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

                const createdMs = toEpochMs(tweet.created_at);
                if (Number.isFinite(createdMs) && searchCapture) {
                    searchCapture.oldestCollectedMs = Math.min(
                        searchCapture.oldestCollectedMs ?? Infinity, createdMs);
                }

                currentExport.tweetBuffer.push(tweet);
                currentExport.tweetCount++;

                if (currentExport.tweetBuffer.length >= XPorterStorage.MAX_TWEETS_PER_BATCH) {
                    await flushExportBuffer();
                }
            }

            if (quantityLimitReached()) {
                hasMore = false;
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
        seenUrls: new Set(),
        oldestCollectedMs: null // drives the overlay's date-based progress %
    };

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
        message.phase = overlayPhase(i18n, phaseKey, currentExport.username);
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
    const seenIds = new Set();
    await preloadSeenIds(seenIds);

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
            break;
        }

        const result = await rateLimiter.executeWithRateLimit(async () => {
            return await fetchFn(
                currentExport.userId,
                currentExport.cursor
            );
        });
        if (!currentExport.running) break;

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
            if (quantityLimitReached()) {
                hasMore = false;
                break;
            }
            seenIds.add(user.id);

            currentExport.tweetBuffer.push(user);
            currentExport.tweetCount++;

            if (currentExport.tweetBuffer.length >= XPorterStorage.MAX_TWEETS_PER_BATCH) {
                await flushExportBuffer();
            }
        }

        if (quantityLimitReached()) {
            hasMore = false;
        }
        // Update cursor
        if (hasMore && result.nextCursor) {
            currentExport.cursor = result.nextCursor;
        } else {
            hasMore = false;
        }

        // Buffer first, then the advanced cursor — see _fetchPostsLoop.
        await flushExportBuffer();
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
    await closeSearchCaptureTab();
    // Acknowledge only after the loop exits, so a Resume/Start issued right
    // after this response can't collide with the unwinding loop.
    await waitForLoopUnwind();
    return { success: true };
}

async function resumeExport() {
    await waitForLoopUnwind();
    if (exportStarting || exportLoopPromise || (currentExport && currentExport.running)) {
        return { error: 'ALREADY_RUNNING' };
    }
    exportStarting = true;
    try {
        return await _resumeExportInner();
    } finally {
        exportStarting = false;
    }
}

async function _resumeExportInner() {
    const savedState = await XPorterStorage.loadExportState();
    if (!savedState) {
        return { error: 'No export to resume' };
    }

    const settings = await XPorterStorage.loadSettings();

    rateLimiter = createRateLimiter(settings, savedState.exportMode || 'posts');
    lastTransientStatus = null;
    // Restore request counters so the batch/cooldown rhythm and the "batch N"
    // indicator stay accurate after resuming (previously reset to zero).
    rateLimiter.restoreState(savedState.rateLimiterState);

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
        cursor: savedState.cursor,
        startedAt: savedState.startedAt,
        status: 'fetching'
    };

    launchExportLoop('Resume export error:');

    XPorterStorage.recordExportStart(currentExport.exportMode, currentExport.outputFormat, {
        resume: true,
        dateRange: !!(currentExport.dateFrom || currentExport.dateTo)
    }).then(refreshUninstallURL).catch(() => {});

    return { success: true, status: 'resumed', tweetCount: currentExport.tweetCount };
}

async function getExportStatus() {
    if (currentExport) {
        const waitUntil = rateLimiter?.waitUntil || manualWaitUntil || null;
        const transient = currentExport.running && waitUntil > Date.now() && lastTransientStatus
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
            until: waitUntil,
            canResume: !currentExport.running &&
                (currentExport.status === 'stopped' || currentExport.status === 'error') &&
                !!currentExport.userId,
            ...transient
        };
    }

    // Check saved state
    const savedSettings = await applyAutoExpiration();
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
            quantityLimit: savedSettings?.quantityLimit || 0,
            error: savedState.error || null,
            startedAt: savedState.startedAt,
            completedAt: savedState.completedAt,
            userInfo: savedState.userInfo,
            exportMode: savedState.exportMode,
            outputFormat: savedState.outputFormat,
            canResume: (savedState.status === 'stopped' || savedState.status === 'error') && !!savedState.userId
        };
    }

    return { running: false, status: 'idle' };
}

// ==================== Download (Multi-Format) ====================

async function downloadExport(format) {
    const allItems = await XPorterStorage.loadAllTweets();
    if (allItems.length === 0) {
        return { error: 'NO_DATA' };
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
    await applyAutoExpiration();
    const entry = await XPorterStorage.loadExportHistoryEntry(id);
    if (!entry) {
        return { error: 'HISTORY_NOT_FOUND' };
    }
    if (!Array.isArray(entry.items) || entry.items.length === 0) {
        return { error: 'HISTORY_DATA_GONE' };
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

    // Localize CSV/XLSX header labels when the user opts in (default on). The
    // underlying data keys — and all JSON keys — always stay English.
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
        content = XPorterCSV.generateSimpleXLSX(allItems, isUsers, headerOpts);
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
    const blob = new Blob([content], { type: mimeType });
    const reader = new FileReader();

    return new Promise((resolve) => {
        reader.onerror = () => {
            resolve({ error: 'DOWNLOAD_FAILED' });
        };
        reader.onload = () => {
            chrome.downloads.download({
                url: reader.result,
                filename: filename,
                saveAs: true
            }, (downloadId) => {
                // A blocked/rejected download surfaces only here — reporting
                // success anyway would show a false "Download started" toast.
                if (chrome.runtime.lastError || downloadId === undefined) {
                    XLog.error('Download failed:', chrome.runtime.lastError?.message);
                    resolve({ error: 'DOWNLOAD_FAILED' });
                    return;
                }
                // Anonymous usage counter — "actually got a file in hand" is a
                // stronger signal than a completed fetch. Fire and forget.
                XPorterStorage.recordDownload().then(refreshUninstallURL).catch(() => {});
                resolve({ success: true, downloadId, count: allItems.length, filename });
            });
        };
        reader.readAsDataURL(blob);
    });
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

async function downloadFeedDatabase(outputFormat) {
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

    const now = new Date();
    const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const filename = `XPorter_seen_posts_${stamp}.${format}`;
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
                    resolve({ error: 'DOWNLOAD_FAILED' });
                    return;
                }
                resolve({ success: true, downloadId, count: rows.length, filename });
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

async function applyAutoExpiration() {
    const settings = await XPorterStorage.loadSettings();
    if (settings.autoExpireEnabled === false) return settings;

    const maxAge = Math.max(1, Number(settings.autoExpireHours) || 4) * 60 * 60 * 1000;
    const state = currentExport ? null : await XPorterStorage.loadExportState();
    if (state?.updatedAt && Date.now() - state.updatedAt > maxAge) {
        await XPorterStorage.clearExportState();
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

function broadcastStatus(event) {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({
        type: 'EXPORT_STATUS_UPDATE',
        exportMode: currentExport?.exportMode,
        outputFormat: currentExport?.outputFormat,
        username: currentExport?.username,
        startedAt: currentExport?.startedAt,
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

            currentExport.running = false;
            currentExport.status = 'error';
            currentExport.error = err.message.startsWith('API_ERROR_400') ? 'STALE_QUERY_ID' : err.message;
            await saveCurrentState();
            broadcastStatus({
                running: false,
                status: 'error',
                error: currentExport.error,
                tweetCount: currentExport.tweetCount,
                canResume: !!currentExport.userId
            });
            XPorterStorage.recordExportError(currentExport.error).then(refreshUninstallURL).catch(() => {});
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
    XPorterStorage.recordExportStopped().then(refreshUninstallURL).catch(() => {});
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
            includeArticles: true,
            quantityLimit: 500,
            requestDelay: 3000,
            exportSpeed: 'standard',
            customDelaySec: 5,
            customBatchSize: 20,
            customCooldownMin: 3,
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
