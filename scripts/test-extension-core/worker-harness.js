'use strict';

const vm = require('node:vm');
const { source } = require('./support.js');

// Storage returns detached JSON values, as chrome.storage does. Tests may seed
// batches through getSavedBatches(), but runtime reads never share those objects.
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

function createWorkerHarness() {
    let runtimeListener;
    let savedState = null;
    let cleared = false;
    let firstItemRecords = 0;
    let saveStateSucceeds = true;
    let loadAllCalls = 0;
    let savedHistory = null;
    let aboutAccountCache = {};
    let downloadActive = false;
    let downloadStarts = 0;
    let textReads = 0;
    const savedBatches = [];
    const settings = {
        quantityLimit: 500,
        autoExpireEnabled: true,
        autoExpireHours: 4
    };

    const context = vm.createContext({
        console,
        URL,
        Blob,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        importScripts() {},
        XPORTER_CONFIG: { SPEED_PRESETS: { standard: {} } },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        XPorterAPI: {
            discoverEndpoints: async () => ({}),
            getRateLimit: () => null,
            toPostContext: (tweet) => ({ ...tweet }),
            setLiveQueryId() {}
        },
        XPorterCSV: {},
        XPorterColumns: {},
        XPorterFeedback: { refresh() {}, maybeRefresh() {} },
        XPorterDownloads: {
            isCurrentDataReadActive() { return downloadActive; },
            isCurrentDownloadActive() { return downloadActive; },
            async startCurrentDownload() {
                downloadStarts += 1;
                return { success: true };
            },
            async getCurrentPlan() { return { count: 0, partCount: 1 }; },
            async getCurrentPostsText() {
                textReads += 1;
                return { error: 'NO_DATA' };
            },
            async downloadCurrent() { return { success: true }; },
            async downloadHistory() { return { success: true }; },
            async downloadSeenPosts() { return { success: true }; }
        },
        XPorterPostDB: {
            upsertPosts: async () => ({}),
            getSummary: async () => ({ count: 0 }),
            getAllPosts: async () => [],
            clear: async () => {}
        },
        XPorterStorage: {
            async saveExportState(state) {
                if (!saveStateSucceeds) return false;
                savedState = copy({ ...state, updatedAt: Date.now() });
                return true;
            },
            async loadExportState() { return copy(savedState); },
            async loadSettings() { return { ...settings }; },
            async clearExportState() { cleared = true; savedState = null; return true; },
            async pruneExpiredExportHistory() { return { changed: false, expired: 0 }; },
            async loadDetectedUsername() { return ''; },
            async loadUsage() { return {}; },
            async markInstalled() {},
            async backfillInstalledAt() {},
            async saveSettings() { return true; },
            async recordExportStart() {},
            async recordExportPhase() {},
            async recordFirstItem() { firstItemRecords += 1; },
            async recordExportComplete() {},
            async recordExportStopped() {},
            async recordExportError() {},
            async loadAllTweets() { loadAllCalls += 1; return copy(savedBatches.flat()); },
            async saveTweetBatch(index, items) { savedBatches[index] = copy(items); return true; },
            async loadTweetBatch(index) { return copy(savedBatches[index] || []); },
            async loadAboutAccountCache() {
                return JSON.parse(JSON.stringify(aboutAccountCache));
            },
            async saveAboutAccountCache(cache) {
                aboutAccountCache = JSON.parse(JSON.stringify(cache));
                return true;
            },
            async saveExportHistory(entry) { savedHistory = copy(entry); return true; }
        },
        RateLimitManager: class {
            constructor(options) {
                Object.assign(this, options);
            }
        },
        detectBrowserLanguage: () => 'en',
        loadTranslations: async () => ({}),
        chrome: {
            storage: { local: { setAccessLevel: async () => {} } },
            runtime: {
                id: 'test-extension',
                onInstalled: { addListener() {} },
                onStartup: { addListener() {} },
                onMessage: { addListener(listener) { runtimeListener = listener; } },
                getManifest: () => ({ version: '1.4.8' }),
                setUninstallURL() {},
                getPlatformInfo: async () => ({ os: 'mac' }),
                sendMessage: async () => ({})
            },
            tabs: {
                query: async () => [],
                create: async () => ({ id: 1 }),
                remove: async () => {},
                update: async () => {},
                sendMessage: async () => ({})
            },
            action: {
                setBadgeText() {},
                setBadgeBackgroundColor() {}
            }
        }
    });
    const configContext = vm.createContext({});
    vm.runInContext(source('utils/config.js'), configContext);
    context.XPORTER_CONFIG.SEARCH_CAPTURE = { ...configContext.XPORTER_CONFIG.SEARCH_CAPTURE };
    context.XPORTER_CONFIG.EXPORT_STATE_SCHEMA_VERSION = configContext.XPORTER_CONFIG.EXPORT_STATE_SCHEMA_VERSION;
    vm.runInContext(source('utils/shared.js'), context, { filename: 'utils/shared.js' });
    vm.runInContext(source('background/export-policy.js'), context, {
        filename: 'background/export-policy.js'
    });
    vm.runInContext(source('background/service-worker.js'), context, { filename: 'background/service-worker.js' });
    return {
        context,
        dispatchRuntime(message, sender) {
            return new Promise(resolve => runtimeListener(copy(message), copy(sender), resolve));
        },
        setSavedState(state) { savedState = copy(state); },
        getSavedState() { return copy(savedState); },
        wasCleared() { return cleared; },
        firstItemRecords() { return firstItemRecords; },
        setSaveStateSucceeds(value) { saveStateSucceeds = value; },
        loadAllCalls() { return loadAllCalls; },
        getSavedHistory() { return savedHistory; },
        setAboutAccountCache(cache) { aboutAccountCache = JSON.parse(JSON.stringify(cache)); },
        getAboutAccountCache() { return aboutAccountCache; },
        getSavedBatches() { return savedBatches; },
        setDownloadActive(value) { downloadActive = value; },
        downloadStarts() { return downloadStarts; },
        textReads() { return textReads; }
    };
}

module.exports = { createWorkerHarness };
