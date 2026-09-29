// XPorter — Background Service Worker
// Orchestrates the export process and handles popup/content-script messages

// Import utility scripts (paths relative to this service worker's location)
importScripts(
    '../utils/config.js',
    '../utils/capture-contract.js', // relay size caps, re-validated at this boundary
    '../utils/shared.js',
    '../utils/api-features.js',
    '../utils/api-parsers.js',
    '../utils/native-request-template.js',
    '../utils/transaction-id.js',
    '../utils/api.js',
    './export-policy.js',
    '../utils/rateLimit.js',
    '../utils/columns-i18n.js',
    '../utils/csv.js',
    '../utils/storage.js',
    '../utils/diagnostics.js',
    '../utils/diagnostics-codec.js',
    '../utils/post-database.js',
    '../popup/i18n.js', // loadTranslations() — used to localize the in-page capture overlay
    '../popup/theme-presets.js',
    './uninstall-feedback.js',
    './download-diagnostics.js',
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

// Optional in small VM fixtures; all production events use this failure-safe queue.
function diagnose(type, data) {
    return globalThis.XPorterDiagnostics?.record(type, data) || Promise.resolve(null);
}

diagnose('recover').then(() => globalThis.XPorterDownloadDiagnostics?.recover?.()).catch(() => {});

async function diagnosticRejection(error, context = {}) {
    await diagnose('rejected', { ...context, error });
    return { error };
}

async function diagnoseStart(operation, context) {
    await diagnose('attempt', context);
    try {
        const result = await operation();
        if (result?.error) await diagnose('terminal', { result: 'rejected', error: result.error });
        return result;
    } catch (error) {
        await diagnose('terminal', { result: 'rejected', error: error.message });
        throw error;
    }
}

// The three limiters belong to one export lifecycle even though they pace
// different X endpoints. Keep lifecycle operations on this canonical list so
// Stop, status, live settings, and terminal cleanup cannot omit one.
function exportRateLimiterResources() {
    return [
        { limiter: rateLimiter, mode: currentExport?.exportMode },
        { limiter: bookmarkContextRateLimiter, mode: 'bookmark_context' },
        { limiter: aboutRateLimiter, mode: 'about_account' }
    ].filter(resource => resource.limiter);
}

function clearExportRateLimiters() {
    rateLimiter = null;
    bookmarkContextRateLimiter = null;
    aboutRateLimiter = null;
}

// Keep the historical helper names in this worker's lexical scope so existing
// orchestration and VM tests use the extracted policy without call-site churn.
const {
    hasExplicitPostSelection,
    postFeedPlanForSettings,
    canDropRepliesFromSelection,
    postSelectionAllowsTweet,
    resolveRateLimitWaitMinutes,
    buildRateLimiterOptions,
    resolveAboutAccountBatchSize,
    buildResumeSettings,
    PACING_SETTING_KEYS
} = XPorterExportPolicy;

// Synchronous latch closing the async window between the `running` check and
// `currentExport` assignment in start/resume (two rapid START_EXPORT messages
// could otherwise both pass the guard and spawn two competing loops).
let exportStarting = false;
let exportDataMutationStarting = false;

function downloadOwnsExportData() {
    if (typeof XPorterDownloads.isCurrentDataReadActive === 'function') {
        return XPorterDownloads.isCurrentDataReadActive();
    }
    return XPorterDownloads.isCurrentDownloadActive?.() === true;
}

function exportOwnsDownloadData() {
    return exportDataMutationStarting ||
        exportStarting ||
        !!exportLoopPromise ||
        currentExport?.running === true;
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
    let appearance = {};
    try {
        const settings = await XPorterStorage.loadSettings();
        appearance = { theme: settings.theme, simplifiedDesign: settings.simplifiedDesign, uiScale: settings.uiScale };
        lang = settings.language || (typeof detectBrowserLanguage === 'function' ? detectBrowserLanguage() : 'en');
    } catch (_) { /* default en */ }
    let tr = {};
    try {
        if (typeof loadTranslations === 'function') tr = await loadTranslations(lang);
    } catch (_) { /* default en fallbacks below */ }
    const g = (k, fallback) => (tr[k] !== undefined ? tr[k] : fallback);
    const dir = ['ar', 'fa', 'he', 'ur'].includes(lang) ? 'rtl' : 'ltr';
    const strings = {
        appearance,
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
        searchLoading: g('searchLoading', 'Loading search…'),
        searchConnecting: g('searchConnecting', 'Connecting to search…'),
        searchWaiting: g('searchWaiting', 'Waiting for X…'),
        searchCollecting: g('searchCollecting', 'Collecting posts…'),
        searchRetrying: g('searchRetrying', 'Retrying search…')
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
        case 'loading': return i18n.searchLoading;
        case 'connecting': return i18n.searchConnecting;
        case 'waiting': return i18n.searchWaiting;
        case 'collecting': return i18n.searchCollecting;
        case 'retrying': return i18n.searchRetrying;
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
    // Reject before any handler runs: a forbidden message has no side effects.
    if (!isAllowedMessageSender(message, sender)) {
        sendResponse({ error: 'FORBIDDEN' });
        return false;
    }
    handleMessage(message, sender).then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
    });
    return true; // async response
});

// The only messages content/content.js sends. X page contexts are untrusted,
// so everything else (exports, downloads, settings, history, telemetry)
// requires an extension page such as the popup.
const CONTENT_SCRIPT_MESSAGE_TYPES = new Set([
    'SET_USERNAME',
    'SET_CURRENT_ACCOUNT',
    'DISCOVERED_REQUEST_TEMPLATE',
    'PAGE_GRAPHQL_RESPONSE',
    'CAPTURE_FEED_POSTS',
    'STOP_EXPORT' // the in-page date-range overlay's Stop button
]);

function isExtensionPageSender(sender) {
    const extensionRoot = typeof chrome.runtime.getURL === 'function'
        ? chrome.runtime.getURL('')
        : '';
    if (!extensionRoot || !sender || sender.id !== chrome.runtime.id) return false;
    if (typeof sender.url !== 'string' || !sender.url.startsWith(extensionRoot)) return false;
    if (sender.origin && `${sender.origin}/` !== extensionRoot) return false;
    // An extension page opened as a tab carries sender.tab with its own URL;
    // a web page's tab never qualifies.
    return !sender.tab || String(sender.tab.url || '').startsWith(extensionRoot);
}

function isAllowedMessageSender(message, sender) {
    if (CONTENT_SCRIPT_MESSAGE_TYPES.has(message?.type) && isXPageSender(sender)) return true;
    return isExtensionPageSender(sender);
}

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
            if (exportOwnsDownloadData()) return { error: 'ALREADY_RUNNING' };
            return await XPorterDownloads.startCurrentDownload(message.outputFormat);

        case 'GET_DOWNLOAD_PLAN':
            return await XPorterDownloads.getCurrentPlan(message.outputFormat);

        case 'GET_EXPORT_TEXT':
            if (exportOwnsDownloadData()) return { error: 'ALREADY_RUNNING' };
            return await XPorterDownloads.getCurrentPostsText();

        case 'DOWNLOAD_HISTORY_ENTRY':
            await applyAutoExpiration();
            return await XPorterDownloads.downloadHistory(message.id, message.outputFormat);

        case 'RESUME_EXPORT':
            return await resumeExport(message.extraItems);

        case 'RESUME_POSTS_ONLY':
            return await resumePostsOnly();

        case 'SAVE_SETTINGS':
            const settingsPatch = { ...message.settings };
            // Ignore obsolete sharing preferences from older popup instances.
            delete settingsPatch.diagnosticsSharing;
            delete settingsPatch.diagnosticsConsentVersion;
            if (!await XPorterStorage.saveSettings(settingsPatch)) {
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

        case 'DIAGNOSTIC_CLIPBOARD_COPIED':
            if (!sender?.url?.startsWith(chrome.runtime.getURL('popup/'))) return { error: 'INVALID_SENDER' };
            await diagnose('clipboard');
            return {success:true};
        case 'DIAGNOSTIC_START_REJECTED':
            if (!sender?.url?.startsWith(chrome.runtime.getURL('popup/'))) return { error: 'INVALID_SENDER' };
            await diagnose('rejected', {mode:message.mode,format:message.format,error:message.error,
                dateRange:message.dateRange === true,settings:await XPorterStorage.loadSettings()});
            return {success:true};

        case 'CLEAR_EXPORT':
            if (exportOwnsDownloadData()) return { error: 'ALREADY_RUNNING' };
            exportDataMutationStarting = true;
            try {
                if (downloadOwnsExportData()) {
                    return { error: 'DOWNLOAD_IN_PROGRESS' };
                }
                if (!await XPorterStorage.clearExportState()) {
                    return { error: 'STORAGE_FULL' };
                }
                clearExportRateLimiters();
                currentExport = null;
                setBadge('');
                return { success: true };
            } finally {
                exportDataMutationStarting = false;
            }

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
            if (!isValidFeedPostsMessage(message)) return { error: 'INVALID_POSTS' };
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

        case 'XP_LADYBUG_SQUASH':
            await XPorterStorage.recordLadybugSquash();
            await XPorterFeedback.refresh();
            return { success: true };

        case 'XP_SESSION_OPEN':
            // Popup was opened — count it and refresh the snapshot.
            await XPorterStorage.recordOpen();
            await diagnose('open');
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

// Re-check the relay's caps here: the isolated content world enforces them
// too, but this worker is the trust boundary for what reaches storage.
function captureLimit(key, fallback) {
    const value = globalThis.XPorterCaptureContract?.[key];
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isValidFeedPostsMessage(message) {
    const operationName = message?.operationName;
    const posts = message?.posts;
    const maxPosts = captureLimit('MAX_POSTS_PER_MESSAGE', 250);
    const maxText = captureLimit('MAX_POST_TEXT_CHARS', 25000);
    const contract = globalThis.XPorterCaptureContract;
    const isPostOperation = typeof contract?.isPostOperation === 'function'
        ? contract.isPostOperation(operationName)
        : /(Timeline|Tweets|TweetDetail|Bookmarks|Likes|Community|ListLatest|UserMedia)/i.test(operationName);
    return typeof operationName === 'string' &&
        /^[A-Za-z0-9_]{1,80}$/.test(operationName) &&
        isPostOperation &&
        Array.isArray(posts) && posts.length > 0 && posts.length <= maxPosts &&
        posts.every(post => post && typeof post === 'object' && !Array.isArray(post) &&
            /^\d{5,30}$/.test(String(post.id || '')) &&
            typeof post.text === 'string' && post.text.length <= maxText);
}

function isXPageSender(sender) {
    // Content scripts always arrive with a tab. Chrome sets sender.id for
    // every internal message; a different extension id is never trusted.
    if (!sender?.tab) return false;
    if (sender.id !== undefined && sender.id !== chrome.runtime.id) return false;
    try {
        // sender.origin is the frame's own origin (Chrome 80+); fall back to
        // the frame URL, then the tab URL, for older callers.
        const url = new URL(sender.origin || sender.url || sender.tab.url || '');
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

// Shared Start/Resume/Posts-only preconditions. The checks and the latch are
// one synchronous section: no await may separate them, or two rapid messages
// could both pass and spawn competing loops.
async function withExportStartLatch(diagnosticContext, operation) {
    await waitForLoopUnwind();
    if (exportStarting || exportDataMutationStarting || exportLoopPromise ||
        (currentExport && currentExport.running)) {
        return diagnosticRejection('ALREADY_RUNNING', diagnosticContext);
    }
    if (downloadOwnsExportData()) return diagnosticRejection('DOWNLOAD_IN_PROGRESS', diagnosticContext);
    exportStarting = true;
    try {
        return await operation();
    } finally {
        exportStarting = false;
    }
}

async function startExport({ username, dateFrom, dateTo, exportMode, outputFormat }) {
    return withExportStartLatch({ mode: exportMode, format: outputFormat }, async () => diagnoseStart(
        () => _startExportInner({ username, dateFrom, dateTo, exportMode, outputFormat }),
        { mode: exportMode || 'posts', format: outputFormat || 'csv',
            dateRange: !!(dateFrom || dateTo), settings: await XPorterStorage.loadSettings() }
    ));
}

async function _startExportInner({ username, dateFrom, dateTo, exportMode, outputFormat }) {
    const settings = await XPorterStorage.loadSettings();
    const mode = exportMode || 'posts';
    const isBookmarks = mode === 'bookmarks';
    const normalizedDateFrom = (mode === 'posts') ? normalizeDateBoundary(dateFrom, 'start') : null;
    const normalizedDateTo = (mode === 'posts') ? normalizeDateBoundary(dateTo, 'end') : null;

    if (mode === 'posts' && ((dateFrom && !normalizedDateFrom) || (dateTo && !normalizedDateTo) ||
        (normalizedDateFrom && normalizedDateTo && normalizedDateFrom > normalizedDateTo))) {
        return { error: 'INVALID_DATE_RANGE' };
    }
    const postFeedPlan = mode === 'posts' ? postFeedPlanForSettings(settings) : [];
    if (mode === 'posts' && postFeedPlan.length === 0) {
        return { error: 'NO_POST_TYPES_SELECTED' };
    }

    // Initialize rate limiter with current settings. The provider lets it pace
    // adaptively from X's live x-rate-limit-* budget (fixed delay is fallback).
    clearExportRateLimiters();
    rateLimiter = createRateLimiter(settings, mode);
    aboutAccountCache = null;
    lastTransientStatus = null;
    _overlayI18n = null; // re-read the UI language for this export's overlay

    rateLimiter.onStatusChange((event) => {
        lastTransientStatus = event;
        broadcastStatus({ ...event, exportMode: mode });
    });

    // Clear previous export data
    if (!await XPorterStorage.clearExportState()) {
        clearExportRateLimiters();
        return { error: 'STORAGE_FULL' };
    }

    currentExport = {
        running: true,
        schemaVersion: XPORTER_CONFIG.EXPORT_STATE_SCHEMA_VERSION,
        // Bookmarks are owned by the signed-in viewer. Never carry a typed or
        // tab-detected profile handle into this personal export.
        username: isBookmarks ? '' : username,
        exportMode: mode,
        outputFormat: outputFormat || 'csv',
        dateFrom: normalizedDateFrom,
        dateTo: normalizedDateTo,
        // Preserve the selected calendar labels independently of UTC bounds
        // and of the timezone at a later Resume or history download.
        dateFromCalendar: normalizedDateFrom ? dateFrom : null,
        dateToCalendar: normalizedDateTo ? dateTo : null,
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
        postFeedPlan,
        postFeedIndex: 0,
        startedAt: Date.now(),
        dateSnapshotAt: Date.now(),
        status: 'resolving_user',
        completionReason: null
    };

    // Save initial state before acknowledging the start. A failed write must
    // not leave an in-memory export marked running with no loop behind it.
    try {
        await saveCurrentState();
    } catch (error) {
        currentExport = null;
        clearExportRateLimiters();
        return { error: error.message };
    }

    // Anonymous usage counter (for uninstall feedback) — fire and forget
    await diagnose('started', {settings:currentExport.settings});
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
                rateLimiter.resetCounters?.();
            } catch (err) {
                if (err.message === 'NOT_LOGGED_IN') throw new Error('NOT_LOGGED_IN');
                if (err.message === 'USER_NOT_FOUND') throw new Error('USER_NOT_FOUND');
                if (err.message === 'USER_SUSPENDED') throw new Error('USER_SUSPENDED');
                if (err.message.startsWith('ENDPOINT_DISCOVERY_FAILED')) throw new Error('ENDPOINT_DISCOVERY_FAILED');
                throw err;
            }
        }

        // A protected account is readable by its owner and approved
        // followers, so isProtected alone never blocks the export. The fetch
        // loops report ACCOUNT_PRIVATE only when the first page is refused
        // or comes back empty (see fetchFirstPageGuarded).

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

        // A Stop that lands after the last page already proved the source
        // finished must not leave a resumable 'stopped' state: Resume would
        // restart the feed from a null cursor and duplicate saved rows.
        if (!currentExport.running && !exportSourceFinished(currentExport)) {
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

        // History is a secondary copy: its failure must not turn an export
        // whose rows and complete state are already saved into an error.
        try {
            await saveCompletedExportHistory();
        } catch (historyError) {
            XLog.warn('Could not save export history:', historyError.message);
        }

        // Anonymous usage counter (for uninstall feedback) — fire and forget
        const itemsDelta = Math.max(0, currentExport.tweetCount - (currentExport.itemsRecordedBase || 0));
        XPorterStorage.recordExportComplete(itemsDelta).then(XPorterFeedback.refresh).catch(() => {});
        diagnose('terminal', { result: 'complete', rows: currentExport.tweetCount,
            completion: currentExport.completionReason });

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
            if (aboutAccountCache) {
                await XPorterStorage.saveAboutAccountCache(aboutAccountCache).catch(() => false);
            }
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

// True once the whole source (every planned profile feed) has been read or
// the quantity target was reached. Such a run is finished even if Stop
// arrived in the same moment.
function exportSourceFinished(state) {
    const reason = state?.completionReason;
    if (!['source_exhausted', 'no_matches', 'limit_reached'].includes(reason)) return false;
    if (reason === 'limit_reached') return true;
    const plan = Array.isArray(state.postFeedPlan) ? state.postFeedPlan : [];
    const isFeedPlan = (state.exportMode || 'posts') === 'posts' && !state.dateFrom && !state.dateTo;
    return !isFeedPlan || plan.length === 0 || (Number(state.postFeedIndex) || 0) >= plan.length - 1;
}

async function saveCompletedExportHistory() {
    const ui = currentExport.userInfo || {};
    const isBookmarks = currentExport.exportMode === 'bookmarks';
    const historyLimit = Number(XPORTER_CONFIG.EXPORT_HISTORY_DATA_LIMIT) || 5000;
    const keepPayload = currentExport.tweetCount <= historyLimit;
    // A failed read keeps the history entry, only without its row payload.
    const historyItems = keepPayload
        ? await XPorterStorage.loadAllTweets().catch(() => null)
        : null;
    await XPorterStorage.saveExportHistory({
        username: isBookmarks ? '' : (ui.screenName || currentExport.username),
        displayName: isBookmarks ? 'Bookmarks' : (ui.name || currentExport.username),
        profileImageUrl: isBookmarks ? '' : (ui.profileImageUrl || ''),
        userInfo: { ...ui },
        exportMode: currentExport.exportMode,
        itemCount: currentExport.tweetCount,
        outputFormat: currentExport.outputFormat || 'csv',
        postSelection: currentExport.exportMode === 'posts'
            ? {
                postSelectionVersion: currentExport.settings?.postSelectionVersion,
                includeOriginalPosts: currentExport.settings?.includeOriginalPosts === true,
                includeQuotes: currentExport.settings?.includeQuotes === true,
                includeReplies: currentExport.settings?.includeReplies === true,
                includeRetweets: currentExport.settings?.includeRetweets === true,
                includeArticles: currentExport.settings?.includeArticles === true
            }
            : null,
        includeAboutAccountDetails:
            currentExport.settings?.includeAboutAccountDetails === true,
        dateFrom: currentExport.dateFrom?.toISOString() || null,
        dateTo: currentExport.dateTo?.toISOString() || null,
        dateFromCalendar: currentExport.dateFromCalendar || null,
        dateToCalendar: currentExport.dateToCalendar || null,
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
    if (currentExport.dateFrom || currentExport.dateTo) {
        // Not best-effort: an empty set here would re-append every saved row.
        // A read failure (STORAGE_READ_FAILED) ends the run as a resumable error.
        const savedItems = await XPorterStorage.loadAllTweets();
        for (const item of savedItems) {
            if (item?.id) seenIds.add(item.id);
        }
        return;
    }
    // Resume can deliberately replay a partly consumed page. Unreadable
    // saved IDs must stop that replay, or duplicates consume its quantity
    // budget and hide the remaining rows.
    const startBatch = Math.max(0, currentExport.totalBatches - 3);
    for (let i = startBatch; i < currentExport.totalBatches; i++) {
        const batch = await XPorterStorage.loadTweetBatch(i);
        for (const item of batch) {
            if (item?.id) seenIds.add(item.id);
        }
    }
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
    const acceptTweet = (tweet, profileFeed) => {
        if (!postSelectionAllowsTweet(currentExport.settings, tweet)) return false;
        if (hasExplicitPostSelection(currentExport.settings)) {
            if (profileFeed === 'replies' && tweet.type !== 'reply') return false;
            if (profileFeed !== 'replies' &&
                profileFeed !== 'legacy_with_replies' &&
                tweet.type === 'reply') return false;
        }

        // The combined timeline contains foreign conversation rows. X may omit
        // their display fields, so username-only filtering can mistake a
        // foreign parent for a target-profile post and later backfill the
        // target's name. Prefer the stable internal author id when available;
        // an unidentified combined-feed row is context only, never primary.
        if (profileFeed === 'legacy_with_replies') {
            const expectedAuthorId = String(currentExport.userId || '');
            const actualAuthorId = String(tweet?._author_id || '');
            if (expectedAuthorId && actualAuthorId) {
                return actualAuthorId === expectedAuthorId;
            }
            if (!tweet.author_username) return false;
        }

        // Reply timelines can contain foreign conversation rows so X can draw
        // context. The parser already attached a matching direct parent (and a
        // quote inside it) to the profile reply as `reply_to_post`; keep that
        // nested context, but never export the foreign row as a primary item.
        return !(tweet.author_username && expectedUsername &&
            tweet.author_username.toLowerCase() !== expectedUsername.toLowerCase());
    };
    const plan = currentExport.postFeedPlan?.length
        ? currentExport.postFeedPlan
        : postFeedPlanForSettings(currentExport.settings);
    currentExport.postFeedPlan = plan;
    if (!Number.isInteger(currentExport.postFeedIndex) ||
        currentExport.postFeedIndex < 0 ||
        currentExport.postFeedIndex >= plan.length) {
        currentExport.postFeedIndex = 0;
    }

    while (currentExport.postFeedIndex < plan.length && currentExport.running) {
        const profileFeed = plan[currentExport.postFeedIndex];
        const remainingFeeds = plan.length - currentExport.postFeedIndex;
        const countBeforeFeed = currentExport.tweetCount;
        const maxNewItems = () => {
            const totalLimit = Number(currentExport.settings?.quantityLimit) || 0;
            if (totalLimit <= 0 || remainingFeeds <= 1) return 0;
            const remainingRows = Math.max(0, totalLimit - countBeforeFeed);
            return Math.max(1, Math.ceil(remainingRows / remainingFeeds));
        };
        // Live pacing changes rebuild limiter options from this field, so
        // they keep pacing the endpoint this feed actually calls.
        currentExport.activeProfileFeed = profileFeed;
        rateLimiter?.reconfigure?.(primaryLimiterOptions());
        await _fetchPostTimelineLoop(
            (cursor) => XPorterAPI.fetchUserTweets(
                currentExport.userId,
                cursor,
                20,
                profileFeed
            ),
            (tweet) => acceptTweet(tweet, profileFeed),
            { maxNewItems }
        );

        if (!currentExport.running ||
            currentExport.completionReason === 'limit_reached') {
            return;
        }
        if (currentExport.postFeedIndex >= plan.length - 1) return;

        currentExport.postFeedIndex += 1;
        currentExport.cursor = null;
        currentExport.completionReason = null;
        await saveCurrentState();
    }
}

async function _fetchBookmarksLoop() {
    // A bookmark is a primary row because the viewer explicitly saved it.
    // Do not apply profile-author, repost, reply, or article filters here.
    await _fetchPostTimelineLoop(
        (cursor) => XPorterAPI.fetchBookmarks(cursor, 20),
        () => true,
        {
            // Reply context runs after the primary limiter returned the page,
            // never inside its request: a context 429 must not make the
            // Bookmarks limiter wait again and refetch the same page, and a
            // context failure must not end the Bookmarks export.
            afterPage: async (page) => {
                if (currentExport.settings.includeBookmarkReplyContext !== false) {
                    try {
                        await enrichBookmarkReplyContexts(page.tweets || []);
                    } catch (error) {
                        if (error.message === 'ABORTED') throw error;
                        XLog.warn('Bookmark reply context unavailable:', error.message);
                    }
                }
                if (currentExport.settings.includeBookmarkArticles === false) {
                    for (const tweet of (page.tweets || [])) {
                        removeArticlePayload(tweet);
                    }
                }
            }
        }
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

// isProtected alone cannot block an export: the owner and approved followers
// can read a protected account. Only when the very first page of a fresh run
// is refused (401/403 → AUTH_ERROR, or UserUnavailable) or empty is the
// account reported private.
function protectedFirstPagePending() {
    return currentExport?.userInfo?.isProtected === true &&
        currentExport.exportMode !== 'bookmarks' &&
        !currentExport.cursor &&
        !(Number(currentExport.postFeedIndex) > 0) &&
        (currentExport.tweetCount || 0) === 0 &&
        !currentExport.totalBatches;
}

async function fetchFirstPageGuarded(request, rowsOf) {
    const probe = protectedFirstPagePending();
    let result;
    try {
        result = await request();
    } catch (error) {
        // X may also answer a protected timeline with UserUnavailable.
        if (probe && ['AUTH_ERROR', 'USER_UNAVAILABLE'].includes(error.message)) {
            throw new Error('ACCOUNT_PRIVATE');
        }
        throw error;
    }
    if (probe && currentExport.running && rowsOf(result).length === 0) {
        throw new Error('ACCOUNT_PRIVATE');
    }
    return result;
}

async function _fetchPostTimelineLoop(fetchPage, acceptTweet, { maxNewItems = 0, afterPage = null } = {}) {
    let hasMore = true;
    let noProgressPages = 0;
    const countAtFeedStart = currentExport.tweetCount;
    const currentFeedBudget = () => typeof maxNewItems === 'function'
        ? Number(maxNewItems()) || 0
        : Number(maxNewItems) || 0;
    const feedBudgetReached = () => {
        const budget = currentFeedBudget();
        return budget > 0 &&
            currentExport.tweetCount - countAtFeedStart >= budget;
    };
    const seenIds = new Set();
    await preloadSeenIds(seenIds);
    const recentIds = createRecentIdTracker(seenIds);

    while (hasMore && currentExport.running) {
        // Check quantity limit
        if (quantityLimitReached()) {
            currentExport.completionReason = 'limit_reached';
            break;
        }
        if (feedBudgetReached()) break;

        const requestCursor = currentExport.cursor;
        const result = await fetchFirstPageGuarded(
            () => rateLimiter.executeWithRateLimit(() => fetchPage(requestCursor)),
            (page) => page?.tweets || []
        );
        if (!currentExport.running) break;
        if (afterPage) {
            await afterPage(result);
            if (!currentExport.running) break;
        }

        const countBeforePage = currentExport.tweetCount;

        for (const tweet of (result.tweets || [])) {
            if (!currentExport.running) break;
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
            if (feedBudgetReached()) {
                hasMore = false;
            }

            if (currentExport.tweetBuffer.length >= XPorterStorage.MAX_TWEETS_PER_BATCH) {
                await flushExportBuffer();
                await saveCurrentState({ bestEffort: true });
            }
            if (!hasMore) break;
        }

        // Stop may arrive during an awaited batch write. Its unread page
        // remainder must stay behind the request cursor for Resume.
        if (!currentExport.running) {
            await flushExportBuffer();
            break;
        }

        const limitReachedThisPage = quantityLimitReached();
        if (limitReachedThisPage) hasMore = false;

        // Forward progress is measured AFTER filtering and de-duplication. X
        // occasionally repeats a non-empty page with the same cursor; treating
        // raw rows as progress made the loop spin forever at a fixed count and
        // every Resume repeated the same no-op page.
        const acceptedNew = currentExport.tweetCount - countBeforePage;
        const cursorAdvanced = !!result.nextCursor && result.nextCursor !== requestCursor;
        noProgressPages = (acceptedNew > 0 || cursorAdvanced) ? 0 : (noProgressPages + 1);

        // Commit rows before mutating the cursor or completion reason.
        // On a failed write the error handler must persist the current page.
        await flushExportBuffer();
        // A partial GraphQL page contains usable rows but cannot certify its
        // cursor or terminal boundary. Keep these rows and replay this page
        // after the user resumes the classified failure.
        if (result.partialError) throw new Error(result.partialError);
        if (limitReachedThisPage) currentExport.completionReason = 'limit_reached';

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

        // Rows are durable; the advanced cursor can now be persisted.
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
    if (!dateValue || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return null;
    // Calendar dates belong to the browser's timezone, including DST.
    const normalized = new Date(`${dateValue}T00:00:00`);
    if (!Number.isFinite(normalized.getTime()) || formatLocalDate(normalized) !== dateValue) return null;
    if (boundary === 'end') normalized.setHours(23, 59, 59, 999);
    return normalized;
}

function formatLocalDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateExportUpperBound() {
    const snapshot = Number(currentExport?.dateSnapshotAt || currentExport?.startedAt) || Date.now();
    const requested = toEpochMs(currentExport?.dateTo);
    return Number.isFinite(requested) ? Math.min(requested, snapshot) : snapshot;
}

function dateExportAuthorMatches(tweet) {
    const expectedId = String(currentExport.userId || '');
    const actualId = String(tweet?._author_id || '');
    if (expectedId && actualId) return actualId === expectedId;
    const expected = currentExport.userInfo?.screenName || currentExport.username || '';
    return !!tweet?.author_username && tweet.author_username.toLowerCase() === expected.toLowerCase();
}

// X post IDs are snowflakes: the top bits hold milliseconds since the X
// epoch. They are an exact creation time when created_at is unparseable.
const SNOWFLAKE_EPOCH_MS = 1288834974657n;

function tweetCreatedAtMs(tweet) {
    const created = toEpochMs(tweet?.created_at);
    if (Number.isFinite(created)) return created;
    const id = String(tweet?.id || '');
    if (!/^\d{1,20}$/.test(id)) return NaN;
    try {
        const ms = Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH_MS);
        // IDs below the snowflake era carry no timestamp.
        return BigInt(id) >> 22n > 0n && Number.isFinite(ms) ? ms : NaN;
    } catch (_) {
        return NaN;
    }
}

function dateExportInRange(created) {
    const from = toEpochMs(currentExport.dateFrom);
    return (!Number.isFinite(from) || created >= from) && created <= dateExportUpperBound();
}

// Author and calendar check for one search row. A row whose time cannot be
// determined is not in range; the loop marks such a run unconfirmed.
function dateExportAllowsTweet(tweet) {
    if (!dateExportAuthorMatches(tweet)) return false;
    const created = tweetCreatedAtMs(tweet);
    return Number.isFinite(created) && dateExportInRange(created);
}

// Wait for a SearchTimeline 429: until the relayed x-rate-limit-reset when
// known, else 60 s doubling per consecutive 429 (capped). Never beyond what is
// left of the user's X-limit wait budget.
function searchRateLimitWaitMs(payload, consecutive, budgetLeft) {
    const config = XPORTER_CONFIG.SEARCH_CAPTURE;
    const maxPause = config.rateLimitMaxPauseMs || 15 * 60 * 1000;
    let wait = Math.min(maxPause, (config.rateLimitPauseMs || 60000) * 2 ** Math.max(0, consecutive - 1));
    const resetMs = Number(payload?.rateLimitReset) * 1000;
    if (Number.isFinite(resetMs) && resetMs > Date.now()) {
        wait = resetMs - Date.now() + 1000;
    }
    return Math.max(1000, Math.min(wait, budgetLeft));
}

async function _fetchPostsByDateRangeLoop() {
    const seenIds = new Set();
    await preloadSeenIds(seenIds);
    // Freeze today's upper bound across Resume; new posts require a new export.
    currentExport.dateSnapshotAt ||= currentExport.startedAt || Date.now();
    if (toEpochMs(currentExport.dateFrom) > dateExportUpperBound()) {
        currentExport.completionReason = 'no_matches';
        currentExport.cursor = null;
        return;
    }
    const rawQuery = buildDateRangeSearchQuery(currentExport.username, currentExport.dateFrom,
        new Date(dateExportUpperBound()));
    let previousCursor = null;
    // A later clean terminal page cannot certify earlier partial responses.
    // Resume replays the whole query, so only a clean replay clears this doubt.
    let hasPartialSearchResults = false;
    let skippedPayloads = 0;
    let stalledPages = 0;
    let badPages = 0;
    let failedPage = null;
    // 429s have their own budget: the user's X-limit wait setting, like the
    // RateLimitManager, instead of the 3-strike failure budget.
    let rateLimitedSince = null;
    let rateLimitedPages = 0;
    const rateLimitBudgetMs = resolveRateLimitWaitMinutes(currentExport.settings || {}) * 60 * 1000;
    // Every raw row ID seen in this run. A page is progress only when it
    // reveals at least one ID not seen before, whatever its cursor says.
    const scannedIds = new Set();
    let probeProtected = protectedFirstPagePending() && !currentExport.dateResume;
    try {
        await openSearchCaptureTab(rawQuery);
        // Stop may land while the tab is being created; do not wait for X.
        if (!currentExport.running) return;
        await setSearchPhase('loading');
        let payload = await waitForSearchCapturePayload(XPORTER_CONFIG.SEARCH_CAPTURE.initialResponseTimeoutMs);
        if (!payload) payload = await requestNextSearchCapturePayload();
        if (!payload && currentExport.running) throw new Error('SEARCH_NO_RESPONSE');

        while (payload && currentExport.running) {
            // X also requests the Top cursor when its UI scrolls upward.
            // Only the initial response or the expected Bottom request can
            // advance this export or prove the downward source is exhausted.
            // The relay always sets requestCursor (null for the first page);
            // only synthetic fixtures omit it.
            if (Object.hasOwn(payload, 'requestCursor') && payload.requestCursor !== previousCursor) {
                // Every ignored payload restarts the response budget, so bound
                // consecutive skips: endless Top refreshes must not wait forever.
                if (++skippedPayloads > XPORTER_CONFIG.SEARCH_CAPTURE.maxSkippedPayloads) {
                    throw new Error('SEARCH_STALLED');
                }
                payload = await requestNextSearchCapturePayload();
                if (!payload && currentExport.running) payload = await recoverStalledSearchCapture();
                continue;
            }
            if (payload.error && payload.error !== 'SEARCH_NETWORK_ERROR') throw new Error(payload.error);
            if (quantityLimitReached()) {
                currentExport.completionReason = 'limit_reached';
                break;
            }
            // A later native response cannot repair a missing page. Resume
            // restarts the query and deduplicates the rows already saved.
            if (failedPage && payload.url !== failedPage.url) throw new Error(failedPage.error);
            let parsed;
            let failure = payload.error || null;
            if (!failure && (payload.status === 401 || payload.status === 403)) {
                throw new Error(probeProtected ? 'ACCOUNT_PRIVATE' : 'AUTH_ERROR');
            }
            if (!failure && payload.status >= 400) {
                failure = payload.status === 429 ? 'RATE_LIMITED' : 'SEARCH_RESPONSE_ERROR';
            } else if (!failure) {
                let response;
                try {
                    response = JSON.parse(payload.bodyText);
                    parsed = XPorterAPI.parseSearchTimelineResponse(response);
                } catch (error) {
                    // Native search can return HTTP 200 with GraphQL code 88.
                    // Classify rejected pages like direct API requests, while
                    // preserving the parser's accepted partial-result pages.
                    failure = response?.errors && error.message === 'SEARCH_RESPONSE_ERROR'
                        ? XPorterAPI.classifyGraphqlErrors(response.errors).message
                        : (error.message === 'SEARCH_RESPONSE_ERROR'
                            ? error.message : 'SEARCH_INVALID_RESPONSE');
                }
            }
            if (failure === 'AUTH_ERROR') throw new Error(probeProtected ? 'ACCOUNT_PRIVATE' : failure);
            if (failure) {
                failedPage ||= { url: payload.url, error: failure };
                searchCapture?.seenUrls.delete(payload.url);
                if (failure === 'RATE_LIMITED') {
                    rateLimitedSince ??= Date.now();
                    rateLimitedPages += 1;
                    const budgetLeft = rateLimitBudgetMs - (Date.now() - rateLimitedSince);
                    if (budgetLeft < 1000) throw new Error(failure);
                    const duration = searchRateLimitWaitMs(payload, rateLimitedPages, budgetLeft);
                    const until = Date.now() + duration;
                    lastTransientStatus = { running: true, status: 'cooldown', duration,
                        until, kind: 'window', reason: 'SearchTimeline HTTP 429' };
                    broadcastStatus(lastTransientStatus);
                    await sendSearchCaptureStatus({ pauseUntil: until });
                    await swSleep(duration);
                } else {
                    if (++badPages >= XPORTER_CONFIG.SEARCH_CAPTURE.maxConsecutiveFailures) throw new Error(failure);
                    await setSearchPhase('retrying');
                    await swSleep(XPORTER_CONFIG.SEARCH_CAPTURE.retryDelayMs);
                }
                if (!currentExport.running) break;
                payload = await requestNextSearchCapturePayload();
                if (!payload && currentExport.running) throw new Error(failure);
                continue;
            }
            badPages = 0;
            failedPage = null;
            skippedPayloads = 0;
            rateLimitedSince = null;
            rateLimitedPages = 0;
            hasPartialSearchResults ||= parsed.hasPartialErrors === true;
            const pageRows = parsed.tweets || [];
            if (probeProtected && pageRows.length === 0) {
                throw new Error('ACCOUNT_PRIVATE');
            }
            probeProtected = false;
            await setSearchPhase('collecting');
            let newUniqueIds = 0;
            for (const tweet of pageRows) {
                if (!currentExport.running) break;
                const rowId = String(tweet?.id || '');
                if (rowId && !scannedIds.has(rowId)) {
                    scannedIds.add(rowId);
                    newUniqueIds += 1;
                }
                if (!dateExportAuthorMatches(tweet)) continue;
                // Only fill display fields after author identity has been verified.
                tweet.author_name ||= currentExport.userInfo?.name || '';
                tweet.author_username ||= currentExport.userInfo?.screenName || currentExport.username || '';
                if (!postSelectionAllowsTweet(currentExport.settings, tweet)) continue;
                if (seenIds.has(tweet.id)) {
                    if (currentExport.dateResume && searchCapture) searchCapture.resumeScanned++;
                    continue;
                }
                const created = tweetCreatedAtMs(tweet);
                if (!Number.isFinite(created)) {
                    // Never silently call a run complete after dropping a
                    // target row whose date is unknown; skip it and leave the
                    // run unconfirmed so Resume can replay the query.
                    hasPartialSearchResults = true;
                    continue;
                }
                if (!dateExportInRange(created)) continue;
                if (quantityLimitReached()) break;
                seenIds.add(tweet.id);
                currentExport.tweetBuffer.push(tweet);
                currentExport.tweetCount++;
                recordFirstItemOnce();
                if (currentExport.tweetBuffer.length >= XPorterStorage.MAX_TWEETS_PER_BATCH) {
                    await flushExportBuffer();
                }
            }
            // Persist every accepted page BEFORE waiting for the next response.
            await flushExportBuffer();
            // Stop can interrupt the row loop during an awaited batch write.
            // The response's terminal cursor says nothing about that unread
            // remainder: Resume must replay this page and deduplicate its rows.
            if (!currentExport.running) break;
            if (quantityLimitReached()) currentExport.completionReason = 'limit_reached';
            else if (parsed.sourceExhausted === true) {
                if (hasPartialSearchResults) throw new Error('SEARCH_END_UNCONFIRMED');
                currentExport.completionReason = currentExport.tweetCount ? 'source_exhausted' : 'no_matches';
            }
            const cursor = parsed.nextCursor;
            stalledPages = newUniqueIds > 0 ? 0 : stalledPages + 1;
            if (!currentExport.completionReason && stalledPages >= XPORTER_CONFIG.SEARCH_CAPTURE.maxNoProgressPages) {
                throw new Error('SEARCH_STALLED');
            }
            currentExport.cursor = currentExport.completionReason === 'limit_reached'
                ? currentExport.cursor : (currentExport.completionReason ? null : (cursor || null));
            await saveCurrentState();
            if (currentExport.running && !currentExport.completionReason && !cursor) {
                throw new Error('SEARCH_END_UNCONFIRMED');
            }
            await sendSearchCaptureStatus({ phaseKey: 'exporting' });
            broadcastStatus({ running: true, status: 'fetching', searchPhase: 'collecting',
                username: currentExport.username, tweetCount: currentExport.tweetCount,
                quantityLimit: currentExport.settings?.quantityLimit || 0, exportMode: 'posts' });
            if (!currentExport.running || currentExport.completionReason) break;
            previousCursor = cursor;
            await setSearchPhase('waiting');
            payload = await requestNextSearchCapturePayload();
            if (!payload && currentExport.running) payload = await recoverStalledSearchCapture();
            if (!payload && currentExport.running) throw new Error('SEARCH_STALLED');
        }
        if (currentExport.running && !currentExport.completionReason) throw new Error('SEARCH_STALLED');
    } catch (error) {
        // A later invalid row must not discard earlier validated rows in this page.
        try {
            await flushExportBuffer();
        } catch (flushError) {
            XLog.error('Could not persist rows while handling search error:', flushError.message);
        }
        throw error;
    } finally {
        await closeSearchCaptureTab();
    }
}

async function setSearchPhase(phase) {
    if (!currentExport?.running) return;
    currentExport.searchPhase = phase;
    lastTransientStatus = null;
    broadcastStatus({ running: true, status: 'fetching', searchPhase: phase,
        tweetCount: currentExport.tweetCount, exportMode: 'posts' });
    await sendSearchCaptureStatus({ phaseKey: phase });
}

function buildDateRangeSearchQuery(username, dateFrom, dateTo) {
    const parts = [`(from:${username})`];
    // Search dates use UTC calendar boundaries. Add guard days; exact local
    // bounds are enforced on every row. A guard row is never proof of fullness.
    if (dateFrom) {
        const before = new Date(dateFrom.getTime());
        before.setUTCDate(before.getUTCDate() - 1);
        parts.push(`since:${formatDateForSearch(before)}`);
    }
    if (dateTo) {
        const after = new Date(dateTo.getTime());
        after.setUTCDate(after.getUTCDate() + 2);
        parts.push(`until:${formatDateForSearch(after)}`);
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

    // Arm the capture state before navigating to X. Creating the tab directly
    // at the search URL leaves a race where document_start can relay the first
    // SearchTimeline response before chrome.tabs.create() resolves; the worker
    // then drops the only payload because searchCapture does not exist yet.
    const tab = await chrome.tabs.create({
        url: 'about:blank',
        active: true
    }).catch(() => { throw new Error('SEARCH_TAB_UNAVAILABLE'); });

    searchCapture = {
        tabId: tab.id,
        returnTabId: activeTab?.id || null,
        queue: [],
        resolver: null,
        seenUrls: new Set(),
        rawQuery,
        resumeScanned: 0
    };

    // Persist the tab so a worker that dies mid-export can close it on wake
    // (see closeOrphanedSearchTab) instead of leaving a scrolling X tab.
    if (currentExport) {
        currentExport.searchTabId = tab.id;
        await saveCurrentState({ bestEffort: true });
    }

    try {
        await chrome.tabs.update(tab.id, {
            url: buildSearchTimelinePageUrl(rawQuery)
        });
    } catch (_) {
        await closeSearchCaptureTab();
        throw new Error('SEARCH_TAB_UNAVAILABLE');
    }

    const capture = searchCapture;
    setTimeout(() => {
        // Cooldown/retry overlays already have their own status and countdown.
        if (searchCapture === capture && currentExport?.running && !lastTransientStatus) {
            sendSearchCaptureStatus({ phaseKey: currentExport.searchPhase || 'loading' },
                XPORTER_CONFIG.SEARCH_CAPTURE.overlayAttempts);
        }
    }, XPORTER_CONFIG.SEARCH_CAPTURE.overlayInitialDelayMs);
}

async function closeSearchCaptureTab() {
    if (!searchCapture) return;

    const { tabId, returnTabId, resolver } = searchCapture;
    searchCapture = null;
    if (currentExport?.searchTabId === tabId) currentExport.searchTabId = null;

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

function waitForSearchCapturePayload(timeoutMs = XPORTER_CONFIG.SEARCH_CAPTURE.responseTimeoutMs) {
    // Stop closes the capture and wakes the registered resolver; a wait that
    // begins after Stop must not sit out its whole timeout either.
    if (!searchCapture || !currentExport?.running) return Promise.resolve(null);
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
// stalled for an unknown reason. Pause with an amber
// countdown on the overlay and retry; each scroll ping also clicks
// X's Retry button. Returns the recovered payload, or null to give up.
async function recoverStalledSearchCapture(
    rounds = XPORTER_CONFIG.SEARCH_CAPTURE.recoveryRounds,
    waitMs = XPORTER_CONFIG.SEARCH_CAPTURE.recoveryDelayMs
) {
    for (let round = 0; round < rounds; round++) {
        if (!currentExport?.running || !searchCapture) return null;
        await setSearchPhase('retrying');
        await sendSearchCaptureStatus({ pauseUntil: Date.now() + waitMs, pauseLabel: (await getOverlayI18n()).searchRetrying });
        await swSleep(waitMs);
        if (!currentExport?.running || !searchCapture) return null;
        await sendSearchCaptureStatus({ phaseKey: 'scrolling' });
        const payload = await requestNextSearchCapturePayload();
        if (payload) return payload;
    }
    return null;
}

async function requestNextSearchCapturePayload() {
    const capture = searchCapture;
    if (!capture?.tabId || !currentExport?.running) return null;
    let lastFailure = 'SEARCH_NO_RESPONSE';
    for (let attempt = 0; attempt < XPORTER_CONFIG.SEARCH_CAPTURE.responseAttempts &&
        currentExport.running && searchCapture === capture; attempt++) {
        if (capture.queue.length) return capture.queue.shift();
        let tab;
        try { tab = await chrome.tabs.get(capture.tabId); }
        catch (_) { throw new Error('SEARCH_TAB_UNAVAILABLE'); }
        if (tab.status === 'loading' || tab.url === 'about:blank') {
            lastFailure = 'SEARCH_TAB_UNAVAILABLE';
            await setSearchPhase('loading');
        } else {
            let matches = false;
            try {
                const url = new URL(tab.url);
                matches = url.hostname === 'x.com' && url.pathname === '/search' &&
                    url.searchParams.get('q') === capture.rawQuery && url.searchParams.get('f') === 'live';
            } catch (_) { /* no longer our search */ }
            if (!matches) throw new Error('SEARCH_PAGE_CHANGED');
            try {
                const state = await chrome.tabs.sendMessage(capture.tabId, { type: 'XPORTER_SEARCH_PAGE_STATE' });
                if (!state?.hookReady) {
                    lastFailure = 'SEARCH_BRIDGE_UNAVAILABLE';
                    await setSearchPhase('connecting');
                } else {
                    lastFailure = 'SEARCH_NO_RESPONSE';
                    await setSearchPhase('waiting');
                    await chrome.tabs.sendMessage(capture.tabId, { type: 'XPORTER_SCROLL_SEARCH_PAGE' });
                }
            } catch (_) {
                lastFailure = 'SEARCH_BRIDGE_UNAVAILABLE';
                await setSearchPhase('connecting');
            }
        }
        const payload = await waitForSearchCapturePayload(XPORTER_CONFIG.SEARCH_CAPTURE.responseTimeoutMs);
        if (payload) return payload;
    }
    if (currentExport?.running && searchCapture === capture && lastFailure !== 'SEARCH_NO_RESPONSE') {
        throw new Error(lastFailure);
    }
    return null;
}

// Only a user-selected quantity has a known denominator. Calendar coverage
// cannot predict the share of posts collected: posting density varies by date.
function computeSearchCaptureProgress() {
    if (!currentExport) return null;
    const limit = Number(currentExport.settings?.quantityLimit || 0);
    return limit > 0
        ? Math.min(100, Math.round((currentExport.tweetCount || 0) / limit * 100))
        : null;
}

function toEpochMs(value) {
    if (!value) return NaN;
    const ms = (value instanceof Date) ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : NaN;
}

async function sendSearchCaptureStatus(overrides = {}, attempts = 1) {
    if (!searchCapture?.tabId || !currentExport) return false;
    const capture = searchCapture;
    const revision = (capture.statusRevision || 0) + 1;
    capture.statusRevision = revision;
    const i18n = await getOverlayI18n();
    if (searchCapture !== capture || capture.statusRevision !== revision) return false;
    const { phaseKey, ...rest } = overrides;

    const message = {
        type: 'XPORTER_SEARCH_CAPTURE_STATUS',
        username: currentExport.username,
        tweetCount: currentExport.tweetCount || 0,
        quantityLimit: currentExport.settings?.quantityLimit || 0,
        dateFrom: currentExport.dateFromCalendar || (currentExport.dateFrom ? formatLocalDate(currentExport.dateFrom) : ''),
        dateTo: currentExport.dateToCalendar || (currentExport.dateTo ? formatLocalDate(currentExport.dateTo) : ''),
        progressPct: computeSearchCaptureProgress(),
        i18n,
        ...rest
    };
    if (phaseKey) {
        const effectivePhase = currentExport.dateResume && ['collecting', 'exporting', 'scrolling'].includes(phaseKey)
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
        // A newer phase or another capture invalidates pending retries.
        if (searchCapture !== capture || capture.statusRevision !== revision) return false;
        try {
            await chrome.tabs.sendMessage(capture.tabId, message);
            return true;
        } catch (_) {
            await new Promise(resolve => setTimeout(resolve, XPORTER_CONFIG.SEARCH_CAPTURE.overlayRetryDelayMs));
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
        message.bodyText.length > captureLimit('MAX_BODY_CHARS', 8 * 1024 * 1024) ||
        typeof message.url !== 'string' ||
        message.url.length > 16384 ||
        !message.url.includes('/i/api/graphql/')) {
        return { ignored: true };
    }
    // The relay only forwards real HTTP statuses. A missing or out-of-range
    // status is malformed, never an implicit 200.
    const status = Number(message.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) return { ignored: true };

    let requestCursor = null;
    try {
        const url = new URL(message.url);
        const variables = JSON.parse(url.searchParams.get('variables') || 'null');
        if (url.protocol !== 'https:' || !['x.com', 'twitter.com'].includes(url.hostname) ||
            !url.pathname.endsWith('/SearchTimeline') || variables?.rawQuery !== searchCapture.rawQuery ||
            variables?.product !== 'Latest') return { ignored: true };
        if (variables.cursor != null && typeof variables.cursor !== 'string') return { ignored: true };
        requestCursor = variables.cursor || null;
    } catch (_) { return { ignored: true }; }
    const captureError = ['SEARCH_RESPONSE_TOO_LARGE', 'SEARCH_NETWORK_ERROR'].includes(message.error)
        ? message.error : null;
    // Error responses must remain retryable: the successful retry uses the
    // same cursor URL. Successful payloads are deduplicated until parsing says
    // they were malformed and explicitly removes the URL from this set.
    if (!captureError && status >= 200 && status < 300) {
        if (searchCapture.seenUrls.has(message.url)) {
            return { duplicate: true };
        }
        searchCapture.seenUrls.add(message.url);
    }

    // Optional x-rate-limit-reset (epoch seconds) relayed with a 429. Accept
    // only a plausible value within the next rolling window.
    const rateLimitReset = Number(message.rateLimitReset);
    const nowSeconds = Date.now() / 1000;
    const validReset = Number.isInteger(rateLimitReset) &&
        rateLimitReset > nowSeconds && rateLimitReset <= nowSeconds + 3600;

    const payload = {
        url: message.url,
        requestCursor,
        bodyText: message.bodyText,
        status,
        ...(validReset ? { rateLimitReset } : {}),
        ...(captureError ? { error: captureError } : {})
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
        const result = await fetchFirstPageGuarded(
            () => rateLimiter.executeWithRateLimit(() => fetchFn(
                currentExport.userId,
                requestCursor
            )),
            (page) => Array.isArray(page?.users) ? page.users : []
        );
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

        // Both appending and About enrichment can stop partway through a page.
        // Keep its request cursor until every selected row has been handled.
        if (!currentExport.running) {
            await flushExportBuffer();
            break;
        }

        const limitReachedThisPage = quantityLimitReached();
        if (limitReachedThisPage) hasMore = false;

        const acceptedNew = currentExport.tweetCount - countBeforePage;
        const cursorAdvanced = !!result.nextCursor && result.nextCursor !== requestCursor;
        noProgressPages = (acceptedNew > 0 || cursorAdvanced) ? 0 : (noProgressPages + 1);

        // Commit rows before mutating the cursor or completion reason.
        // On a failed write the error handler must persist the current page.
        await flushExportBuffer();
        // A partial GraphQL page contains usable rows but cannot certify its
        // cursor or terminal boundary. Keep these rows and replay this page
        // after the user resumes the classified failure.
        if (result.partialError) throw new Error(result.partialError);
        if (limitReachedThisPage) currentExport.completionReason = 'limit_reached';

        // Update cursor
        if (hasMore && cursorAdvanced) {
            currentExport.cursor = result.nextCursor;
        } else if (hasMore && !unexpectedInitialEmpty &&
            (!result.nextCursor || noProgressPages >= 3)) {
            currentExport.completionReason = 'source_exhausted';
            currentExport.cursor = null;
            hasMore = false;
        }

        // Rows were committed before advancing the cursor.
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
        if (!currentExport.running || quantityLimitReached()) break;
        currentExport.tweetBuffer.push(user);
        currentExport.tweetCount++;
        recordFirstItemOnce();

        if (currentExport.tweetBuffer.length >= XPorterStorage.MAX_TWEETS_PER_BATCH) {
            await flushExportBuffer();
            await saveCurrentState({ bestEffort: true });
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

async function enrichUsersWithAboutDetails(users, onBatch = null) {
    for (let start = 0; start < users.length;) {
        if (!currentExport.running || quantityLimitReached()) break;
        const batchSize = resolveAboutAccountBatchSize(currentExport.settings);
        const batch = users.slice(start, start + batchSize);
        let batchResults;
        try {
            batchResults = await aboutRateLimiter.executeWithRateLimit(async () => {
                const settled = await Promise.allSettled(
                    batch.map(user => enrichUserWithAboutDetails(user))
                );
                const terminalFailure = settled.find(result =>
                    result.status === 'rejected' &&
                    ['RATE_LIMITED', 'ABORTED'].includes(result.reason?.message)
                );
                if (terminalFailure) {
                    // Retries serve these users from aboutAccountCache, so they
                    // are only appended once: when the limiter finally gives up.
                    terminalFailure.reason.partialResults = settled
                        .filter(result => result.status === 'fulfilled')
                        .map(result => result.value);
                    throw terminalFailure.reason;
                }
                return settled.map((result, index) => result.status === 'fulfilled'
                    ? result.value
                    : { ...batch[index], ...aboutDetailsForUser() });
            });
        } catch (error) {
            const partial = Array.isArray(error?.partialResults) ? error.partialResults : [];
            if (partial.length && onBatch && currentExport.running) await onBatch(partial);
            throw error;
        }
        if (onBatch) await onBatch(batchResults);
        start += batch.length;
    }
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

const STOP_UNWIND_WAIT_MS = 4000;

async function stopExport() {
    // Only signal the loop — it does the single flush + persist + broadcast in
    // its own !running / ABORTED branches. Flushing here too raced the loop's
    // in-flight saveTweetBatch (double-written batch, gap in the indices).
    if (currentExport?.running) {
        currentExport.running = false;
    }
    for (const { limiter } of exportRateLimiterResources()) {
        limiter.abort();
    }
    XPorterAPI.abortActiveRequests?.();
    await closeSearchCaptureTab();
    // Acknowledge after the loop exits, so a Resume/Start issued right after
    // this response can't collide with the unwinding loop. Every wait above
    // is cancellable, so this normally takes well under a second; the bound
    // keeps the reply inside the popup's message timeout, and Start/Resume
    // still wait for the unwind themselves.
    await waitForLoopUnwind(STOP_UNWIND_WAIT_MS);
    return { success: true };
}

async function resumeExport(extraItems) {
    return withExportStartLatch({ resume: true },
        () => diagnoseResume(() => _resumeExportInner(extraItems)));
}

function isZeroRowRepliesFailure(state) {
    return !!state &&
        state.running === false &&
        state.status === 'error' &&
        state.error === 'REPLIES_UNAVAILABLE' &&
        state.exportMode === 'posts' &&
        (state.tweetCount || 0) === 0 &&
        !!state.userId;
}

function canFallbackWithoutReplies(state) {
    return isZeroRowRepliesFailure(state) && canDropRepliesFromSelection(state.settings || {});
}

async function resumePostsOnly() {
    return withExportStartLatch({ resume: true },
        () => diagnoseResume(() => _resumeExportInner(undefined, { postsOnlyFallback: true })));
}

async function diagnoseResume(operation) {
    const state = await XPorterStorage.loadExportState();
    return diagnoseStart(operation, { mode: state?.exportMode, format: state?.outputFormat,
        resume: true, dateRange: !!(state?.dateFrom || state?.dateTo), settings: state?.settings || {} });
}

function applyLivePacingSettings(settingsPatch = {}) {
    if (!currentExport?.running || !currentExport.settings) return false;

    let changed = false;
    let pacingChanged = false;
    for (const key of PACING_SETTING_KEYS) {
        if (!Object.hasOwn(settingsPatch, key)) continue;
        if (currentExport.settings[key] === settingsPatch[key]) continue;
        currentExport.settings[key] = settingsPatch[key];
        changed = true;
        pacingChanged = true;
    }

    // Quantity is a live target for an ordinary run, just like pacing. A
    // completed export resumed through "+N more" owns an explicit per-run
    // override, so later global setting changes must not rewrite that target.
    if (Object.hasOwn(settingsPatch, 'quantityLimit') &&
        !(currentExport.limitOverride > 0)) {
        const quantityLimit = Number(settingsPatch.quantityLimit);
        if (Number.isFinite(quantityLimit) && quantityLimit >= 0 &&
            currentExport.settings.quantityLimit !== quantityLimit) {
            currentExport.settings.quantityLimit = Math.floor(quantityLimit);
            changed = true;
        }
    }
    if (!changed) return false;

    // Reconfigure in place: an in-flight request/wait finishes under the old
    // preset, while the next request uses the new one. Replacing or aborting
    // the limiter here would lose counters or turn a harmless settings change
    // into a failed export.
    if (pacingChanged) {
        for (const { limiter, mode } of exportRateLimiterResources()) {
            limiter.reconfigure?.(
                limiter === rateLimiter
                    ? primaryLimiterOptions()
                    : buildRateLimiterOptions(currentExport.settings, mode)
            );
        }
    }
    return true;
}

// The primary limiter paces the endpoint of the active profile feed. Without
// that feed, a live settings change would switch it to another endpoint's
// x-rate-limit budget (e.g. UserTweets while UserRepliesTimeline runs).
function primaryLimiterOptions() {
    const profileFeed = currentExport?.activeProfileFeed;
    return buildRateLimiterOptions(
        profileFeed ? { ...currentExport.settings, profileFeed } : currentExport.settings,
        currentExport.exportMode
    );
}

function getResumeBlockedReason(state) {
    const hasDates = (state?.exportMode || 'posts') === 'posts' && (state?.dateFrom || state?.dateTo);
    return hasDates && state.schemaVersion !== XPORTER_CONFIG.EXPORT_STATE_SCHEMA_VERSION
        ? 'DATE_EXPORT_RESTART_REQUIRED' : null;
}

async function _resumeExportInner(extraItems, { postsOnlyFallback = false } = {}) {
    const savedState = await XPorterStorage.loadExportState();
    if (!savedState) {
        return { error: 'NO_EXPORT_TO_RESUME' };
    }
    // Neither re-interpret UTC-era bounds nor append differently filtered rows.
    // Keep old batches available to Download; only a new export adopts v1.
    const resumeBlockedReason = getResumeBlockedReason(savedState);
    if (resumeBlockedReason) return { error: resumeBlockedReason };
    if (postsOnlyFallback && !canFallbackWithoutReplies(savedState)) {
        // Dropping replies from a replies-only selection leaves nothing to
        // export; refuse instead of walking a whole feed for zero rows.
        return {
            error: isZeroRowRepliesFailure(savedState)
                ? 'NO_POST_TYPES_SELECTED'
                : 'REPLIES_UNAVAILABLE'
        };
    }

    // A run whose whole source was already read is finished, not resumable:
    // its cursor is null, so Resume would restart the feed and duplicate the
    // saved rows (de-duplication only covers the last few batches). "+N more"
    // cannot extend an exhausted source either.
    if (!postsOnlyFallback && isFinishedSourceState(savedState)) {
        return finalizeFinishedSavedExport(savedState);
    }
    // Stopped right after one planned feed ended: continue with the next
    // feed instead of re-reading the finished one from its start.
    const advanceToNextFeed = !postsOnlyFallback &&
        savedState.completionReason === 'source_exhausted' &&
        !exportSourceFinished(savedState);

    const storedSettings = await XPorterStorage.loadSettings();
    const settings = buildResumeSettings(storedSettings, savedState.settings);
    if (postsOnlyFallback) settings.profileFeed = 'legacy_posts';

    // "+N more" resumes raise the limit for THIS export only, by overriding
    // the per-export settings snapshot — the stored quantityLimit setting is
    // never touched. (The popup used to SAVE_SETTINGS the bumped value, which
    // permanently rewrote the user's configured limit on every resume.)
    // The override persists with the export state so it survives a SW death.
    const extra = parseInt(extraItems, 10);
    let limitOverride = savedState.limitOverride || 0;
    const canExtendCompletedExport = savedState.status === 'complete' &&
        !['source_exhausted', 'no_matches'].includes(savedState.completionReason);
    if (canExtendCompletedExport && Number.isFinite(extra) && extra > 0) {
        limitOverride = (savedState.tweetCount || 0) + extra;
    }
    if (limitOverride > 0) {
        settings.quantityLimit = limitOverride;
    }

    clearExportRateLimiters();
    rateLimiter = createRateLimiter(settings, savedState.exportMode || 'posts');
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
        schemaVersion: savedState.schemaVersion || XPORTER_CONFIG.EXPORT_STATE_SCHEMA_VERSION,
        exportMode: savedState.exportMode || 'posts',
        outputFormat: savedState.outputFormat || 'csv',
        dateFrom: savedState.dateFrom ? new Date(savedState.dateFrom) : null,
        dateTo: savedState.dateTo ? new Date(savedState.dateTo) : null,
        dateFromCalendar: savedState.dateFromCalendar || null,
        dateToCalendar: savedState.dateToCalendar || null,
        settings: settings,
        tweetCount: savedState.tweetCount || 0,
        itemsRecordedBase: savedState.tweetCount || 0,
        totalBatches: savedState.totalBatches || 0,
        tweetBuffer: [],
        userId: savedState.userId,
        userInfo: savedState.userInfo,
        cursor: (postsOnlyFallback || advanceToNextFeed) ? null : savedState.cursor,
        postFeedPlan: postsOnlyFallback
            ? ['legacy_posts']
            : (savedState.postFeedPlan || postFeedPlanForSettings(settings)),
        postFeedIndex: postsOnlyFallback
            ? 0
            : (savedState.postFeedIndex || 0) + (advanceToNextFeed ? 1 : 0),
        startedAt: savedState.startedAt,
        dateSnapshotAt: savedState.dateSnapshotAt || savedState.startedAt,
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
        clearExportRateLimiters();
        return { error: error.message };
    }

    // Enqueue the per-run usage reset before the loop can collect its first
    // resumed item. This keeps first_item_ms tied to this resume attempt.
    XPorterStorage.recordExportStart(currentExport.exportMode, currentExport.outputFormat, {
        resume: true,
        dateRange: !!(currentExport.dateFrom || currentExport.dateTo)
    }).then(XPorterFeedback.refresh).catch(() => {});
    await diagnose('started', {settings:currentExport.settings});
    _lastRecordedUsagePhase = 'fetching';

    launchExportLoop('Resume export error:');

    return {
        success: true,
        status: 'resumed',
        tweetCount: currentExport.tweetCount,
        partialReason: currentExport.partialReason
    };
}

function isFinishedSourceState(state) {
    return ['source_exhausted', 'no_matches'].includes(state?.completionReason) &&
        exportSourceFinished(state);
}

// Persist a stopped/errored state whose source was already proven finished
// as the complete export it is.
async function finalizeFinishedSavedExport(savedState) {
    const wasComplete = savedState.status === 'complete';
    currentExport = {
        ...savedState,
        dateFrom: savedState.dateFrom ? new Date(savedState.dateFrom) : null,
        dateTo: savedState.dateTo ? new Date(savedState.dateTo) : null,
        tweetBuffer: [],
        running: false,
        status: 'complete',
        error: null,
        completedAt: savedState.completedAt || Date.now()
    };
    try {
        await saveCurrentState();
    } catch (error) {
        currentExport = null;
        return { error: error.message };
    }
    if (!wasComplete) {
        try {
            await saveCompletedExportHistory();
        } catch (historyError) {
            XLog.warn('Could not save export history:', historyError.message);
        }
    }
    broadcastStatus({
        running: false,
        status: 'complete',
        tweetCount: currentExport.tweetCount,
        username: currentExport.username,
        exportMode: currentExport.exportMode,
        startedAt: currentExport.startedAt,
        completedAt: currentExport.completedAt
    });
    return {
        success: true,
        status: 'complete',
        tweetCount: currentExport.tweetCount || 0,
        completionReason: currentExport.completionReason
    };
}

async function getExportStatus() {
    // Expire terminal data even while this worker still holds it in memory.
    const savedSettings = currentExport?.running ? null : await applyAutoExpiration();
    const liveState = currentExport;
    const state = liveState || await XPorterStorage.loadExportState();
    if (!state) return { running: false, status: 'idle' };

    // A persisted running flag without an in-memory loop means Chrome killed
    // the worker. Repair it before returning the same status contract as a live run.
    if (!liveState && state.running) {
        state.running = false;
        state.status = 'stopped';
        await closeOrphanedSearchTab(state);
        await XPorterStorage.saveExportState(state);
    }
    // Older builds could persist a count with no batches behind it; the popup
    // then offers a Download that always answers "No data". Clamp it.
    if (!liveState && !state.running && !state.totalBatches && state.tweetCount > 0) {
        state.tweetCount = 0;
        await XPorterStorage.saveExportState(state);
    }

    let waitUntil = null;
    let transient = {};
    if (liveState) {
        waitUntil = Math.max(
            ...exportRateLimiterResources()
                .map(({ limiter }) => limiter.waitUntil || 0),
            manualWaitUntil || 0
        ) || null;
        const transientStatus = lastTransientStatus?.status;
        const transientIsActive = waitUntil > Date.now() ||
            transientStatus === 'retrying' ||
            transientStatus === 'rate_limited';
        transient = liveState.running && transientIsActive && lastTransientStatus
            ? {
                ...lastTransientStatus,
                until: waitUntil,
                ...(lastTransientStatus.retryIn
                    ? {
                        duration: Number(lastTransientStatus.duration) ||
                            Number(lastTransientStatus.retryIn),
                        retryIn: Math.max(0, waitUntil - Date.now())
                    }
                    : {})
            }
            : {};
    }
    const resumeBlockedReason = getResumeBlockedReason(state);
    const quantityLimit = liveState
        ? (state.settings?.quantityLimit || 0)
        : (state.limitOverride > 0
            ? state.limitOverride
            : (state.settings?.quantityLimit ?? savedSettings?.quantityLimit ?? 0));
    return {
        running: state.running === true,
        status: state.status,
        username: state.username,
        tweetCount: state.tweetCount || 0,
        expectedTweets: getExpectedItemCount(state),
        quantityLimit,
        error: state.error || null,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        userInfo: state.userInfo,
        exportMode: state.exportMode,
        outputFormat: state.outputFormat,
        partialReason: state.partialReason || null,
        completionReason: state.completionReason || null,
        searchPhase: state.searchPhase || null,
        resumeBlockedReason,
        until: waitUntil,
        canResume: !resumeBlockedReason && !state.running &&
            (state.status === 'stopped' || state.status === 'error') && !!state.userId &&
            !isFinishedSourceState(state),
        canFallbackWithoutReplies: canFallbackWithoutReplies(state),
        ...transient
    };
}

// ==================== Helpers ====================

async function saveCurrentState({ bestEffort = false } = {}) {
    if (!currentExport) return;
    diagnose('progress', {rows:currentExport.tweetCount,newItem:false});

    const saved = await XPorterStorage.saveExportState({
        schemaVersion: currentExport.schemaVersion,
        username: currentExport.username,
        userId: currentExport.userId,
        userInfo: currentExport.userInfo,
        cursor: currentExport.cursor,
        postFeedPlan: currentExport.postFeedPlan || null,
        postFeedIndex: currentExport.postFeedIndex || 0,
        // Persist only rows that are actually on disk. A live-settings save can
        // land mid-page while up to 49 counted rows still sit in tweetBuffer;
        // persisting the in-memory count there is how "48 collected" ends up
        // with 0 batches after a worker restart.
        tweetCount: currentExport.tweetCount - (currentExport.tweetBuffer?.length || 0),
        totalBatches: currentExport.totalBatches,
        dateFrom: currentExport.dateFrom?.toISOString() || null,
        dateTo: currentExport.dateTo?.toISOString() || null,
        dateFromCalendar: currentExport.dateFromCalendar || null,
        dateToCalendar: currentExport.dateToCalendar || null,
        exportMode: currentExport.exportMode,
        outputFormat: currentExport.outputFormat,
        status: currentExport.status,
        error: currentExport.error,
        startedAt: currentExport.startedAt,
        dateSnapshotAt: currentExport.dateSnapshotAt,
        completedAt: currentExport.completedAt,
        running: currentExport.running,
        limitOverride: currentExport.limitOverride || 0,
        partialReason: currentExport.partialReason || null,
        completionReason: currentExport.completionReason || null,
        settings: { ...currentExport.settings },
        searchTabId: typeof currentExport.searchTabId === 'number' ? currentExport.searchTabId : null,
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
    // A paused export (stopped by the user or by an X limit) is work in
    // progress, not leftover data: the user was told to come back later and
    // press Resume. Only finished exports expire.
    const expirable = state?.status === 'complete';
    if (expirable && state?.updatedAt && Date.now() - state.updatedAt > maxAge) {
        if (!exportDataMutationStarting && !exportStarting && !exportLoopPromise) {
            exportDataMutationStarting = true;
            try {
                if (!downloadOwnsExportData()) {
                    await XPorterStorage.clearExportState();
                    if (currentExport && !currentExport.running) currentExport = null;
                }
            } finally {
                exportDataMutationStarting = false;
            }
        }
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
        searchPhase: currentExport?.searchPhase || null,
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

            // Rows are persisted in 50-row chunks; a loop that dies on a rate
            // limit (or any other error) can still hold up to 49 collected
            // rows in memory. Without this flush the status shows "48
            // collected" while Download reports "No data".
            try {
                await flushExportBuffer();
            } catch (flushError) {
                XLog.error('Could not persist rows after export error:', flushError.message);
            }
            // Same for About lookups: they are only saved at page end, so an
            // error mid-page would repeat every request on Resume — against the
            // endpoint that just rate-limited us.
            if (aboutAccountCache) {
                await XPorterStorage.saveAboutAccountCache(aboutAccountCache).catch(() => false);
            }

            // The user already pressed Stop — a late failure from the aborted
            // in-flight request must land as the 'stopped' they asked for,
            // not overwrite it with a scary terminal error.
            if (exportRateLimiterResources()
                .some(({ limiter }) => limiter.isAborted?.() === true) &&
                currentExport.running === false) {
                currentExport.status = 'stopped';
                await saveCurrentState({ bestEffort: true });
                recordExportStoppedOnce();
                broadcastStopped();
                return;
            }

            currentExport.running = false;
            currentExport.status = 'error';
            // REST user-list requests still surface HTTP 400 as API_ERROR_400
            // (GraphQL maps it to STALE_QUERY_ID inside api.js).
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
            diagnose('terminal', { result: 'error', error: currentExport.error, rows: currentExport.tweetCount });
        })
        .finally(() => {
            if (exportLoopPromise === tracked) {
                exportLoopPromise = null;
                clearExportRateLimiters();
            }
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
    diagnose('terminal', { result: 'stopped', rows: currentExport.tweetCount });
}

let _lastRecordedUsagePhase = '';

function recordUsagePhase(phase) {
    if (_lastRecordedUsagePhase === phase) return;
    _lastRecordedUsagePhase = phase;
    XPorterStorage.recordExportPhase(phase).then(XPorterFeedback.refresh).catch(() => {});
    diagnose('phase', { phase });
}

function recordFirstItemOnce() {
    // tweetCount can already be > 0 on Resume; this flag belongs to the newly
    // constructed in-memory run, so the first NEW row still records latency.
    if (!currentExport || currentExport._firstItemRecorded) return;
    currentExport._firstItemRecorded = true;
    XPorterStorage.recordFirstItem().then(XPorterFeedback.refresh).catch(() => {});
    diagnose('progress', { rows: currentExport.tweetCount });
}

// ==================== Auto-Resume on Startup ====================

// A date-range export's search tab outlives a worker that Chrome killed. On
// repair, close it only if it still shows X search: tab IDs can be reused
// after a browser restart, and an unrelated tab must never be closed.
async function closeOrphanedSearchTab(state) {
    const tabId = state?.searchTabId;
    if (typeof tabId !== 'number') return;
    state.searchTabId = null;
    try {
        const tab = await chrome.tabs.get(tabId);
        const url = new URL(tab?.url || tab?.pendingUrl || '');
        const isSearchTab = ['x.com', 'twitter.com'].includes(url.hostname) &&
            url.pathname === '/search' && url.searchParams.get('f') === 'live';
        if (isSearchTab) await chrome.tabs.remove(tabId);
    } catch (_) {
        // Already closed.
    }
}

chrome.runtime.onStartup.addListener(async () => {
    try {
        const state = await XPorterStorage.loadExportState();
        if (state && state.running) {
            XLog.log('Resuming interrupted export...');
            state.running = false;
            state.status = 'stopped';
            await closeOrphanedSearchTab(state);
            await XPorterStorage.saveExportState(state);
            // The pre-restart badge still shows a live count — reflect reality:
            // the export survived as a resumable 'stopped', not as running.
            setBadge('II', BADGE_COLORS.stop);
        } else {
            setBadge(''); // don't carry a stale badge into a fresh session
        }
    } catch (error) {
        // An unreadable state is not an absent export. Leave its data and
        // badge intact, and allow a later status request to retry recovery.
        XLog.warn('Could not restore export state on startup:', error.message);
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
// Settings defaults are supplied on read by loadSettings(). An install-time
// full snapshot write could race the first popup edit and overwrite its choice.
chrome.runtime.onInstalled.addListener(async () => {
    // Pre-discover endpoints on install/update
    try {
        await XPorterAPI.discoverEndpoints();
        XLog.log('Endpoints pre-discovered on install/update');
    } catch (e) {
        XLog.warn('Pre-discovery on install failed:', e.message);
    }
});

// ==================== Wake repair ====================
// A freshly started worker owns no export loop, so a persisted running export
// was interrupted when Chrome killed the previous worker. Mark it resumable
// and close its orphaned search tab now instead of waiting for the popup.
async function repairInterruptedExportOnWake() {
    const state = await XPorterStorage.loadExportState();
    if (!state?.running) return;
    await closeOrphanedSearchTab(state);
    // A Start/Resume that arrived meanwhile owns the state now.
    if (currentExport || exportStarting || exportLoopPromise || exportDataMutationStarting) return;
    state.running = false;
    state.status = 'stopped';
    await XPorterStorage.saveExportState(state);
    setBadge('II', BADGE_COLORS.stop);
}

repairInterruptedExportOnWake().catch(() => {});
