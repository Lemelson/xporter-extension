// XPorter — Chrome Storage Helpers
// Persist export state for service worker resilience
// All operations include error handling and quota awareness

const STORAGE_KEYS = {
    EXPORT_STATE: 'xporter_export_state',
    SETTINGS: 'xporter_settings',
    USERNAME: 'xporter_detected_username',
    TWEETS_PREFIX: 'xporter_tweets_batch_',
    EXPORT_HISTORY: 'xporter_export_history'
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
        if (chrome.runtime.lastError) {
            throw new Error(chrome.runtime.lastError.message);
        }
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
        const result = await chrome.storage.local.get(keys);
        if (chrome.runtime.lastError) {
            throw new Error(chrome.runtime.lastError.message);
        }
        return result;
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

// ==================== Cleanup ====================

/**
 * Clear all export data
 */
async function clearExportState() {
    const state = await loadExportState();
    const keysToRemove = [STORAGE_KEYS.EXPORT_STATE];

    if (state && state.totalBatches) {
        for (let i = 0; i <= state.totalBatches; i++) {
            keysToRemove.push(STORAGE_KEYS.TWEETS_PREFIX + i);
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
        id: Date.now(),
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
    if (!saved && entry.items) {
        delete history[0].items;
        history[0].hasData = false;
        return safeSet({ [STORAGE_KEYS.EXPORT_HISTORY]: history });
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

async function loadExportHistoryEntry(id) {
    const history = await loadExportHistory();
    return history.find(e => String(e.id) === String(id)) || null;
}

/**
 * Delete a single history entry by id
 */
async function deleteExportHistoryEntry(id) {
    const history = await loadExportHistory();
    const filtered = history.filter(e => e.id !== id);
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
    return safeSet({ [STORAGE_KEYS.SETTINGS]: settings });
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
        quantityLimit: 500,
        requestDelay: C.REQUEST_DELAY || 3000,
        batchSize: C.BATCH_SIZE || 20,
        cooldownDuration: C.COOLDOWN_DURATION || 180000,
        theme: 'dark',
        autoExpireEnabled: true,
        autoExpireHours: 4,
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

if (typeof globalThis !== 'undefined') {
    globalThis.XPorterStorage = {
        saveExportState, loadExportState,
        saveTweetBatch, loadAllTweets,
        clearExportState,
        saveSettings, loadSettings,
        saveDetectedUsername, loadDetectedUsername,
        saveExportHistory, loadExportHistory, loadExportHistoryEntry,
        deleteExportHistoryEntry, clearExportHistory,
        checkStorageQuota,
        STORAGE_KEYS, MAX_TWEETS_PER_BATCH
    };
}
