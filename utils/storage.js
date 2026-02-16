// XPorter — Chrome Storage Helpers
// Persist export state for service worker resilience

const STORAGE_KEYS = {
    EXPORT_STATE: 'xporter_export_state',
    SETTINGS: 'xporter_settings',
    USERNAME: 'xporter_detected_username',
    TWEETS_PREFIX: 'xporter_tweets_batch_'
};

const MAX_TWEETS_PER_BATCH = 50; // Store tweets in chunks — smaller batches ensure data is persisted quickly

/**
 * Save current export state
 */
async function saveExportState(state) {
    return chrome.storage.local.set({
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
    const result = await chrome.storage.local.get(STORAGE_KEYS.EXPORT_STATE);
    return result[STORAGE_KEYS.EXPORT_STATE] || null;
}

/**
 * Save a batch of tweets to storage
 */
async function saveTweetBatch(batchIndex, tweets) {
    const key = STORAGE_KEYS.TWEETS_PREFIX + batchIndex;
    return chrome.storage.local.set({ [key]: tweets });
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

    const result = await chrome.storage.local.get(keys);
    let allTweets = [];
    for (let i = 0; i < state.totalBatches; i++) {
        const batch = result[STORAGE_KEYS.TWEETS_PREFIX + i] || [];
        allTweets = allTweets.concat(batch);
    }

    return allTweets;
}

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

    return chrome.storage.local.remove(keysToRemove);
}

/**
 * Save settings
 */
async function saveSettings(settings) {
    return chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

/**
 * Load settings with defaults
 */
async function loadSettings() {
    const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return {
        includeRetweets: true,
        includeReplies: true,
        quantityLimit: 500, // default: 500 posts per export
        requestDelay: 3000,
        batchSize: 20,
        cooldownDuration: 180000,
        theme: 'dark',
        ...(result[STORAGE_KEYS.SETTINGS] || {})
    };
}

/**
 * Save detected username from content script
 */
async function saveDetectedUsername(username) {
    return chrome.storage.local.set({ [STORAGE_KEYS.USERNAME]: username });
}

/**
 * Load detected username
 */
async function loadDetectedUsername() {
    const result = await chrome.storage.local.get(STORAGE_KEYS.USERNAME);
    return result[STORAGE_KEYS.USERNAME] || '';
}

if (typeof globalThis !== 'undefined') {
    globalThis.XPorterStorage = {
        saveExportState, loadExportState,
        saveTweetBatch, loadAllTweets,
        clearExportState,
        saveSettings, loadSettings,
        saveDetectedUsername, loadDetectedUsername,
        STORAGE_KEYS, MAX_TWEETS_PER_BATCH
    };
}
