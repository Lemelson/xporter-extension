// XPorter — Chrome Storage Helpers
// Persist export state for service worker resilience
// All operations include error handling and quota awareness

const STORAGE_KEYS = {
    EXPORT_STATE: 'xporter_export_state',
    SETTINGS: 'xporter_settings',
    USERNAME: 'xporter_detected_username',
    TWEETS_PREFIX: 'xporter_tweets_batch_',
    EXPORT_HISTORY: 'xporter_export_history',
    USAGE: 'xporter_usage'
};

const MAX_HISTORY_ENTRIES = 20;
const MAX_HISTORY_DATA_ENTRIES = 5;

// Use config constant if available, otherwise default
const MAX_TWEETS_PER_BATCH = (typeof XPORTER_CONFIG !== 'undefined')
    ? XPORTER_CONFIG.TWEETS_PER_BATCH
    : 50;

// ==================== Storage Quota ====================

/**
 * Check storage usage and warn if approaching quota.
 * Returns { bytesInUse, quota, percentUsed, isWarning }
 */
async function checkStorageQuota() {
    try {
        const bytesInUse = await chrome.storage.local.getBytesInUse(null);
        const hasUnlimitedStorage = chrome.runtime?.getManifest?.().permissions?.includes('unlimitedStorage');
        if (hasUnlimitedStorage) {
            return { bytesInUse, quota: Infinity, percentUsed: 0, isWarning: false };
        }
        const quota = chrome.storage.local.QUOTA_BYTES || 10485760; // 10 MB default
        const threshold = (typeof XPORTER_CONFIG !== 'undefined')
            ? XPORTER_CONFIG.STORAGE_WARN_THRESHOLD
            : 0.8;
        const percentUsed = bytesInUse / quota;
        const isWarning = percentUsed >= threshold;
        if (isWarning) {
            const log = (typeof XLog !== 'undefined') ? XLog : console;
            log.warn(`Storage usage: ${Math.round(percentUsed * 100)}% (${bytesInUse} / ${quota} bytes)`);
        }
        return { bytesInUse, quota, percentUsed, isWarning };
    } catch (e) {
        return { bytesInUse: 0, quota: 0, percentUsed: 0, isWarning: false };
    }
}

// ==================== Safe Storage Wrappers ====================

/**
 * Safe write to chrome.storage.local with error handling
 */
async function safeSet(data) {
    try {
        await chrome.storage.local.set(data);
        return true;
    } catch (e) {
        const log = (typeof XLog !== 'undefined') ? XLog : console;
        log.error('Storage write failed:', e.message);
        return false;
    }
}

/**
 * Safe read from chrome.storage.local with error handling
 */
async function safeGet(keys) {
    try {
        return await chrome.storage.local.get(keys);
    } catch (e) {
        const log = (typeof XLog !== 'undefined') ? XLog : console;
        log.error('Storage read failed:', e.message);
        return {};
    }
}

// ==================== Export State ====================

/**
 * Save current export state
 */
async function saveExportState(state) {
    return safeSet({
        [STORAGE_KEYS.EXPORT_STATE]: {
            ...state,
            updatedAt: Date.now()
        }
    });
}

/**
 * Load current export state
 */
async function loadExportState() {
    const result = await safeGet(STORAGE_KEYS.EXPORT_STATE);
    return result[STORAGE_KEYS.EXPORT_STATE] || null;
}

// ==================== Tweet Batches ====================

/**
 * Save a batch of tweets to storage (with quota check)
 */
async function saveTweetBatch(batchIndex, tweets) {
    // Check quota every 10 batches to reduce overhead
    if (batchIndex % 10 === 0) {
        const { isWarning, percentUsed } = await checkStorageQuota();
        if (isWarning) {
            const log = (typeof XLog !== 'undefined') ? XLog : console;
            log.warn(`Storage at ${Math.round(percentUsed * 100)}% — tweet batch ${batchIndex} may fail`);
        }
    }
    const key = STORAGE_KEYS.TWEETS_PREFIX + batchIndex;
    return safeSet({ [key]: tweets });
}

/**
 * Load all tweet batches
 */
async function loadAllTweets() {
    const state = await loadExportState();
    if (!state || !state.totalBatches) return [];

    const keys = [];
    for (let i = 0; i < state.totalBatches; i++) {
        keys.push(STORAGE_KEYS.TWEETS_PREFIX + i);
    }

    const result = await safeGet(keys);
    const allTweets = [];
    for (let i = 0; i < state.totalBatches; i++) {
        const batch = result[STORAGE_KEYS.TWEETS_PREFIX + i] || [];
        allTweets.push(...batch);
    }

    return allTweets;
}

/**
 * Load one saved export batch.
 */
async function loadTweetBatch(batchIndex) {
    const key = STORAGE_KEYS.TWEETS_PREFIX + batchIndex;
    const result = await safeGet(key);
    return result[key] || [];
}

// ==================== Cleanup ====================

/**
 * Clear all export data
 */
async function clearExportState() {
    const keysToRemove = [STORAGE_KEYS.EXPORT_STATE];

    // Sweep by prefix rather than by the saved totalBatches: a crash between a
    // batch write and the state update — or a new export state overwriting an
    // older, larger one — otherwise strands unreachable batch keys that eat
    // quota forever.
    try {
        const all = await chrome.storage.local.get(null);
        for (const key of Object.keys(all)) {
            if (key.startsWith(STORAGE_KEYS.TWEETS_PREFIX)) {
                keysToRemove.push(key);
            }
        }
    } catch (e) {
        // Prefix sweep unavailable — fall back to the state-derived range.
        const state = await loadExportState();
        if (state && state.totalBatches) {
            for (let i = 0; i <= state.totalBatches; i++) {
                keysToRemove.push(STORAGE_KEYS.TWEETS_PREFIX + i);
            }
        }
    }

    try {
        await chrome.storage.local.remove(keysToRemove);
        return true;
    } catch (e) {
        const log = (typeof XLog !== 'undefined') ? XLog : console;
        log.error('Failed to clear export state:', e.message);
        return false;
    }
}

// ==================== Export History ====================

/**
 * Save a completed export to history (metadata only, max 20 entries FIFO)
 */
async function saveExportHistory(entry) {
    const history = await loadExportHistory();
    history.unshift({
        ...entry,
        // Date.now() alone can collide for same-millisecond writes, making
        // delete-by-id remove two entries.
        id: (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        hasData: Array.isArray(entry.items) && entry.items.length > 0
    });
    // Keep only the most recent entries
    while (history.length > MAX_HISTORY_ENTRIES) {
        history.pop();
    }
    history.forEach((item, index) => {
        if (index >= MAX_HISTORY_DATA_ENTRIES && item.items) {
            delete item.items;
            item.hasData = false;
        }
    });
    const saved = await safeSet({ [STORAGE_KEYS.EXPORT_HISTORY]: history });
    if (!saved) {
        // Quota retry: strip item payloads from EVERY entry, not just the new
        // one — older large entries can be what is actually blocking the write.
        let stripped = false;
        history.forEach(item => {
            if (item.items) {
                delete item.items;
                item.hasData = false;
                stripped = true;
            }
        });
        if (stripped) {
            return safeSet({ [STORAGE_KEYS.EXPORT_HISTORY]: history });
        }
    }
    return saved;
}

/**
 * Load export history array
 */
async function loadExportHistory() {
    const result = await safeGet(STORAGE_KEYS.EXPORT_HISTORY);
    return result[STORAGE_KEYS.EXPORT_HISTORY] || [];
}

function historyEntryCompletedAtMs(entry) {
    const completedAt = entry?.completedAt;
    if (typeof completedAt === 'number' && Number.isFinite(completedAt)) return completedAt;
    if (typeof completedAt === 'string') {
        const parsed = Date.parse(completedAt);
        if (Number.isFinite(parsed)) return parsed;
    }
    // Legacy IDs were Date.now() numbers before UUIDs were introduced.
    const id = Number(entry?.id);
    return Number.isFinite(id) ? id : null;
}

/**
 * Drop downloadable payloads for history entries older than the auto-expire
 * window. The metadata stays visible in Export History.
 */
async function pruneExpiredExportHistory(settings, now = Date.now()) {
    const effectiveSettings = settings || await loadSettings();
    if (effectiveSettings.autoExpireEnabled === false) {
        return { changed: false, expired: 0 };
    }

    const hours = Number(effectiveSettings.autoExpireHours) || 4;
    const maxAge = Math.max(1, hours) * 60 * 60 * 1000;
    const history = await loadExportHistory();
    let changed = false;
    let expired = 0;

    for (const entry of history) {
        const completedAtMs = historyEntryCompletedAtMs(entry);
        const isExpired = Number.isFinite(completedAtMs) && now - completedAtMs > maxAge;
        if (isExpired && entry.items) {
            delete entry.items;
            entry.hasData = false;
            changed = true;
            expired++;
        } else if (!entry.items && entry.hasData) {
            entry.hasData = false;
            changed = true;
        }
    }

    if (changed) {
        await safeSet({ [STORAGE_KEYS.EXPORT_HISTORY]: history });
    }
    return { changed, expired };
}

async function loadExportHistoryEntry(id) {
    const history = await loadExportHistory();
    return history.find(e => String(e.id) === String(id)) || null;
}

/**
 * Delete a single history entry by id
 */
async function deleteExportHistoryEntry(id) {
    const history = await loadExportHistory();
    // Older releases stored numeric Date.now() IDs; DOM dataset/message
    // transport turns them into strings. Compare canonically so those legacy
    // entries remain deletable after migrating new entries to UUIDs.
    const filtered = history.filter(e => String(e.id) !== String(id));
    return safeSet({ [STORAGE_KEYS.EXPORT_HISTORY]: filtered });
}

/**
 * Clear all export history
 */
async function clearExportHistory() {
    return safeSet({ [STORAGE_KEYS.EXPORT_HISTORY]: [] });
}

// ==================== Settings ====================

/**
 * Save settings
 */
async function saveSettings(settings) {
    // Read directly (not via safeGet): a transient read failure must abort the
    // save — merging the patch into {} would silently wipe every other setting.
    let current;
    try {
        const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
        current = result[STORAGE_KEYS.SETTINGS] || {};
    } catch (e) {
        const log = (typeof XLog !== 'undefined') ? XLog : console;
        log.error('Settings read failed — aborting save to avoid wiping settings:', e.message);
        return false;
    }
    return safeSet({
        [STORAGE_KEYS.SETTINGS]: {
            ...current,
            ...settings
        }
    });
}

/**
 * Load settings with defaults
 */
async function loadSettings() {
    const C = (typeof XPORTER_CONFIG !== 'undefined') ? XPORTER_CONFIG : {};
    const result = await safeGet(STORAGE_KEYS.SETTINGS);
    return {
        includeRetweets: true,
        includeReplies: true,
        includeArticles: true,
        quantityLimit: 500,
        requestDelay: C.REQUEST_DELAY || 3000,
        exportSpeed: 'standard',
        customDelaySec: C.CUSTOM_SPEED_LIMITS?.delaySec?.[2] ?? 5,
        customBatchSize: C.CUSTOM_SPEED_LIMITS?.batch?.[2] ?? 20,
        customCooldownMin: C.CUSTOM_SPEED_LIMITS?.cooldownMin?.[2] ?? 3,
        batchSize: C.BATCH_SIZE || 20,
        cooldownDuration: C.COOLDOWN_DURATION || 180000,
        adaptivePacing: (C.ADAPTIVE_PACING !== false),
        theme: 'dark',
        autoExpireEnabled: true,
        autoExpireHours: 4,
        ladybugEnabled: true,
        localizeExportHeaders: true,
        ...(result[STORAGE_KEYS.SETTINGS] || {})
    };
}

// ==================== Username ====================

/**
 * Save detected username from content script
 */
async function saveDetectedUsername(username) {
    return safeSet({ [STORAGE_KEYS.USERNAME]: username });
}

/**
 * Load detected username
 */
async function loadDetectedUsername() {
    const result = await safeGet(STORAGE_KEYS.USERNAME);
    return result[STORAGE_KEYS.USERNAME] || '';
}

// ==================== Usage Stats (for uninstall feedback) ====================
// Anonymous, non-personal counters. Used only to build the uninstall feedback
// URL so churn can be understood. No X data, nothing identifying. Cleared on
// uninstall like all other storage. Disclosed in the privacy policy.

function defaultUsage() {
    return {
        installedAt: 0,
        installVersion: '',
        installedAtApprox: false,
        exportsStarted: 0,
        exportsOk: 0,
        exportsErr: 0,
        exportsStopped: 0,
        byMode: { posts: 0, followers: 0, following: 0, verifiedFollowers: 0 },
        byFormat: { csv: 0, json: 0, xlsx: 0 },
        dateRangeExports: 0,
        resumes: 0,
        downloads: 0,
        itemsTotal: 0,
        lastExportAt: 0,
        lastError: '',
        lastPhase: '',
        firstItemMs: 0,
        currentExportStartedAt: 0,
        // Engagement signals (anonymous): how many times the UI was opened and
        // how much time was actually spent looking at it. Together they tell
        // "installed but never really used" from "used a lot then left".
        opens: 0,
        activeMs: 0,
        lastOpenAt: 0
    };
}

async function loadUsage() {
    const result = await safeGet(STORAGE_KEYS.USAGE);
    return { ...defaultUsage(), ...(result[STORAGE_KEYS.USAGE] || {}) };
}

async function saveUsage(usage) {
    return safeSet({ [STORAGE_KEYS.USAGE]: usage });
}

// All usage mutations are unserialized load→mutate→save; two interleaved
// message handlers (an active-time tick during recordExportStart) would lose
// increments. Serialize them through a single promise chain — every mutation
// happens in the SW context, so an in-process lock is sufficient.
let _usageLock = Promise.resolve();
function withUsageLock(fn) {
    const run = _usageLock.then(fn, fn);
    _usageLock = run.catch(() => {});
    return run;
}

/** Record the first install time + version (no-op if already set). */
function markInstalled(version) {
    return withUsageLock(async () => {
        const usage = await loadUsage();
        if (!usage.installedAt) {
            usage.installedAt = Date.now();
            usage.installVersion = version || '';
            await saveUsage(usage);
        }
        return usage;
    });
}

/** Backfill install time for users who installed before usage tracking existed. */
function backfillInstalledAt() {
    return withUsageLock(async () => {
        const usage = await loadUsage();
        if (!usage.installedAt) {
            usage.installedAt = Date.now();
            usage.installedAtApprox = true;
            await saveUsage(usage);
        }
        return usage;
    });
}

/** Count one open of the popup / export UI. */
function recordOpen() {
    return withUsageLock(async () => {
        const usage = await loadUsage();
        usage.opens = (usage.opens || 0) + 1;
        usage.lastOpenAt = Date.now();
        await saveUsage(usage);
        return usage;
    });
}

/** Accumulate active (visible) time spent in the extension UI, in ms. */
function addActiveMs(ms) {
    const n = Number(ms) || 0;
    if (n <= 0) return Promise.resolve();
    return withUsageLock(async () => {
        const usage = await loadUsage();
        usage.activeMs = (usage.activeMs || 0) + n;
        await saveUsage(usage);
        return usage;
    });
}

/** Bump counters when an export begins (mode + output format known up front). */
function recordExportStart(mode, format, opts = {}) {
    return withUsageLock(async () => {
        const usage = await loadUsage();
        usage.exportsStarted += 1;
        const m = mode === 'verified_followers' ? 'verifiedFollowers' : (mode || 'posts');
        usage.byMode[m] = (usage.byMode[m] || 0) + 1;
        const f = (format || 'csv').toLowerCase();
        usage.byFormat[f] = (usage.byFormat[f] || 0) + 1;
        // Extra churn-analysis signals: the date-range path is separate and
        // fragile (search-tab capture), and resumes were invisible before.
        if (opts.dateRange) usage.dateRangeExports = (usage.dateRangeExports || 0) + 1;
        if (opts.resume) usage.resumes = (usage.resumes || 0) + 1;
        usage.lastPhase = opts.resume ? 'fetching' : 'resolving_user';
        usage.firstItemMs = 0;
        usage.currentExportStartedAt = Date.now();
        await saveUsage(usage);
        return usage;
    });
}

const KNOWN_EXPORT_PHASES = new Set([
    'resolving_user', 'fetching', 'rate_limit', 'complete', 'stopped', 'error'
]);

/** Store only a small whitelisted phase label for uninstall diagnosis. */
function recordExportPhase(phase) {
    if (!KNOWN_EXPORT_PHASES.has(phase)) return Promise.resolve();
    return withUsageLock(async () => {
        const usage = await loadUsage();
        usage.lastPhase = phase;
        await saveUsage(usage);
        return usage;
    });
}

/** Capture time from export start to the first collected row, once per run. */
function recordFirstItem(at = Date.now()) {
    return withUsageLock(async () => {
        const usage = await loadUsage();
        if (!usage.firstItemMs && usage.currentExportStartedAt) {
            usage.firstItemMs = Math.max(0, Math.round(at - usage.currentExportStartedAt));
            await saveUsage(usage);
        }
        return usage;
    });
}

/** Count one file download (fresh export or re-download from history). */
function recordDownload() {
    return withUsageLock(async () => {
        const usage = await loadUsage();
        usage.downloads = (usage.downloads || 0) + 1;
        await saveUsage(usage);
        return usage;
    });
}

/** Bump counters on successful completion. */
function recordExportComplete(itemCount) {
    return withUsageLock(async () => {
        const usage = await loadUsage();
        usage.exportsOk += 1;
        usage.itemsTotal += (itemCount || 0);
        usage.lastExportAt = Date.now();
        usage.lastPhase = 'complete';
        await saveUsage(usage);
        return usage;
    });
}

/** Bump counters when an export is stopped by the user. */
function recordExportStopped() {
    return withUsageLock(async () => {
        const usage = await loadUsage();
        usage.exportsStopped += 1;
        usage.lastExportAt = Date.now();
        usage.lastPhase = 'stopped';
        await saveUsage(usage);
        return usage;
    });
}

// Error codes allowed into the anonymous uninstall URL. The privacy policy
// promises "a short error code" — free text could one day carry a username
// inside a message, so anything unknown is collapsed to UNKNOWN.
const KNOWN_ERROR_CODES = new Set([
    'NOT_LOGGED_IN', 'USER_NOT_FOUND', 'USER_SUSPENDED', 'USER_UNAVAILABLE',
    'ACCOUNT_PRIVATE', 'INVALID_DATE_RANGE', 'RATE_LIMITED', 'STALE_QUERY_ID',
    'AUTH_ERROR', 'ENDPOINT_DISCOVERY_FAILED', 'MAX_RETRIES_EXCEEDED',
    'ABORTED', 'STORAGE_FULL', 'SEARCH_CAPTURE_TIMEOUT', 'DOWNLOAD_FAILED',
    'NETWORK_TIMEOUT'
]);

/** Bump counters on failure (stores a whitelisted error code, no free text). */
function recordExportError(error) {
    return withUsageLock(async () => {
        const usage = await loadUsage();
        usage.exportsErr += 1;
        const code = String(error || '');
        usage.lastError = KNOWN_ERROR_CODES.has(code)
            ? code
            : (/^API_ERROR_\d{3}$/.test(code) ? code : 'UNKNOWN');
        usage.lastExportAt = Date.now();
        usage.lastPhase = 'error';
        await saveUsage(usage);
        return usage;
    });
}

if (typeof globalThis !== 'undefined') {
    globalThis.XPorterStorage = {
        saveExportState, loadExportState,
        saveTweetBatch, loadTweetBatch, loadAllTweets,
        clearExportState,
        saveSettings, loadSettings,
        saveDetectedUsername, loadDetectedUsername,
        saveExportHistory, loadExportHistory, loadExportHistoryEntry,
        pruneExpiredExportHistory,
        deleteExportHistoryEntry, clearExportHistory,
        checkStorageQuota,
        loadUsage, markInstalled, backfillInstalledAt,
        recordOpen, addActiveMs,
        recordExportStart, recordExportPhase, recordFirstItem,
        recordExportComplete, recordExportStopped, recordExportError, recordDownload,
        STORAGE_KEYS, MAX_TWEETS_PER_BATCH
    };
}
