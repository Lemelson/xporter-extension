#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const workerSource = fs.readFileSync(
    path.join(ROOT, 'background/service-worker.js'),
    'utf8'
);
const exportPolicySource = fs.readFileSync(
    path.join(ROOT, 'background/export-policy.js'),
    'utf8'
);

function createWorkerHarness() {
    const limiterInstances = [];
    let contextFetches = 0;

    class FakeRateLimiter {
        constructor(options) {
            this.options = options;
            this.waitUntil = 0;
            this._aborted = false;
            this.reconfigurations = [];
            this.pending = null;
            limiterInstances.push(this);
        }

        onStatusChange(callback) {
            this.statusCallback = callback;
        }

        reconfigure(options) {
            this.options = options;
            this.reconfigurations.push(options);
        }

        restoreState() {}

        getState() {
            return {};
        }

        executeWithRateLimit(request) {
            return new Promise((resolve, reject) => {
                this.pending = { request, resolve, reject };
            });
        }

        abort() {
            this._aborted = true;
            if (this.pending) {
                this.pending.reject(new Error('ABORTED'));
                this.pending = null;
            }
        }
    }

    const storage = {
        async loadSettings() {
            return {
                requestDelay: 1000,
                batchSize: 20,
                cooldownDuration: 180000,
                quantityLimit: 500
            };
        },
        async saveSettings() { return true; },
        async clearExportState() { return true; },
        async saveExportState() { return true; },
        async loadExportState() { return null; },
        async pruneExpiredExportHistory() { return { changed: false, expired: 0 }; },
        async loadDetectedUsername() { return ''; },
        async loadCurrentAccount() { return null; },
        async saveDetectedUsername() { return true; },
        async saveCurrentAccount() { return true; },
        async recordExportStart() {},
        async recordExportPhase() {},
        async recordFirstItem() {},
        async recordExportComplete() {},
        async recordExportStopped() {},
        async recordExportError() {},
        async recordOpen() {},
        async addActiveMs() {},
        async loadAllTweets() { return []; },
        async saveTweetBatch() { return true; },
        async loadTweetBatch() { return []; },
        async saveExportHistory() { return true; },
        async loadExportHistory() { return []; },
        async deleteExportHistoryEntry() { return true; },
        async clearExportHistory() { return true; },
        async loadAboutAccountCache() { return {}; },
        async saveAboutAccountCache() { return true; },
        MAX_TWEETS_PER_BATCH: 50
    };

    const context = vm.createContext({
        console,
        URL,
        Blob,
        Date,
        Math,
        Promise,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        importScripts() {},
        parseLocalizedDecimal(value, fallback) {
            const parsed = Number(String(value ?? '').replace(',', '.'));
            return Number.isFinite(parsed) ? parsed : fallback;
        },
        XPORTER_CONFIG: {
            SPEED_PRESETS: { standard: {} },
            FALLBACK_REQUEST_DELAYS: {
                bookmarks: [1000, 1000],
                bookmark_context: [2000, 2000],
                about_account: [3000, 3000]
            }
        },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        XPorterAPI: {
            getRateLimit() { return null; },
            abortActiveRequests() {},
            async fetchTweetsByIds() {
                contextFetches++;
                return [];
            },
            toPostContext(post) { return post; },
            async discoverEndpoints() { return {}; }
        },
        XPorterStorage: storage,
        XPorterFeedback: { refresh() {}, maybeRefresh() {} },
        XPorterDownloads: {
            async startCurrentDownload() { return { success: true }; },
            async getCurrentPlan() { return {}; },
            async getCurrentPostsText() { return {}; },
            async downloadHistory() { return {}; },
            async downloadSeenPosts() { return {}; }
        },
        XPorterPostDB: {
            async upsertPosts() { return {}; },
            async getSummary() { return {}; },
            async clear() {}
        },
        RateLimitManager: FakeRateLimiter,
        detectBrowserLanguage: () => 'en',
        loadTranslations: async () => ({}),
        chrome: {
            storage: {
                local: {
                    async setAccessLevel() {}
                }
            },
            runtime: {
                id: 'test-extension',
                onMessage: { addListener() {} },
                onStartup: { addListener() {} },
                onInstalled: { addListener() {} },
                getManifest: () => ({ version: '1.6.1' }),
                sendMessage: async () => ({})
            },
            tabs: {
                async query() { return []; },
                async create() { return { id: 1 }; },
                async update() {},
                async remove() {},
                async sendMessage() {}
            },
            action: {
                setBadgeText() {},
                setBadgeBackgroundColor() {}
            }
        }
    });

    vm.runInContext(exportPolicySource, context, {
        filename: 'background/export-policy.js'
    });
    vm.runInContext(workerSource, context, {
        filename: 'background/service-worker.js'
    });
    return {
        context,
        limiterInstances,
        contextFetches: () => contextFetches
    };
}

function setRunningExport(context, overrides = {}) {
    context.__exportState = {
        running: true,
        status: 'fetching',
        username: 'saved',
        exportMode: 'bookmarks',
        outputFormat: 'csv',
        settings: {
            requestDelay: 1000,
            batchSize: 20,
            cooldownDuration: 180000,
            quantityLimit: 500
        },
        tweetCount: 1,
        tweetBuffer: [],
        totalBatches: 1,
        userId: 'current-account',
        userInfo: { tweetCount: 10 },
        startedAt: Date.now(),
        ...overrides
    };
    vm.runInContext('currentExport = globalThis.__exportState', context);
}

function setLimiterBindings(context, primary, bookmark, about) {
    context.__primary = primary;
    context.__bookmark = bookmark;
    context.__about = about;
    vm.runInContext(`
        rateLimiter = globalThis.__primary;
        bookmarkContextRateLimiter = globalThis.__bookmark;
        aboutRateLimiter = globalThis.__about;
    `, context);
}

async function testStopAbortsBookmarkContextLimiter() {
    const harness = createWorkerHarness();
    setRunningExport(harness.context);
    const bookmark = { aborted: 0, abort() { this.aborted++; } };
    setLimiterBindings(
        harness.context,
        { abort() {} },
        bookmark,
        { abort() {} }
    );

    const result = await vm.runInContext('stopExport()', harness.context);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: true });
    assert.equal(bookmark.aborted, 1);
}

async function testStatusUsesBookmarkContextWait() {
    const harness = createWorkerHarness();
    const bookmarkWait = Date.now() + 60_000;
    setRunningExport(harness.context);
    setLimiterBindings(
        harness.context,
        { waitUntil: bookmarkWait - 20_000 },
        { waitUntil: bookmarkWait },
        { waitUntil: bookmarkWait - 10_000 }
    );
    harness.context.__transient = {
        running: true,
        status: 'cooldown',
        kind: 'pacing',
        until: bookmarkWait,
        duration: 60_000
    };
    vm.runInContext(
        'lastTransientStatus = globalThis.__transient',
        harness.context
    );

    const status = await vm.runInContext('getExportStatus()', harness.context);
    assert.equal(status.until, bookmarkWait);
}

async function testLivePacingReconfiguresBookmarkContextLimiter() {
    const harness = createWorkerHarness();
    setRunningExport(harness.context);
    const primary = { calls: [], reconfigure(value) { this.calls.push(value); } };
    const bookmark = { calls: [], reconfigure(value) { this.calls.push(value); } };
    const about = { calls: [], reconfigure(value) { this.calls.push(value); } };
    setLimiterBindings(harness.context, primary, bookmark, about);

    const changed = vm.runInContext(
        'applyLivePacingSettings({ requestDelay: 2500 })',
        harness.context
    );
    assert.equal(changed, true);
    assert.equal(primary.calls.length, 1);
    assert.equal(bookmark.calls.length, 1);
    assert.equal(about.calls.length, 1);
}

async function testTerminalAndErrorCleanupClearEveryLimiter() {
    for (const fails of [false, true]) {
        const harness = createWorkerHarness();
        setRunningExport(harness.context);
        setLimiterBindings(
            harness.context,
            { abort() {}, getState() { return {}; } },
            { abort() {}, getState() { return {}; } },
            { abort() {}, getState() { return {}; } }
        );
        vm.runInContext(
            fails
                ? 'runExportLoop = async () => { throw new Error("BOOM"); }'
                : 'runExportLoop = async () => {}',
            harness.context
        );

        await vm.runInContext(
            'launchExportLoop("test loop:"); exportLoopPromise',
            harness.context
        );
        assert.equal(
            vm.runInContext(
                'rateLimiter === null && bookmarkContextRateLimiter === null && aboutRateLimiter === null',
                harness.context
            ),
            true,
            fails ? 'error cleanup' : 'terminal cleanup'
        );
    }
}

async function testFreshRunClearsStaleSecondaryLimiters() {
    const harness = createWorkerHarness();
    const stalePrimary = { abort() {} };
    const staleBookmark = { abort() {} };
    const staleAbout = { abort() {} };
    setLimiterBindings(
        harness.context,
        stalePrimary,
        staleBookmark,
        staleAbout
    );
    vm.runInContext('launchExportLoop = () => {}', harness.context);

    const result = await vm.runInContext(`_startExportInner({
        username: '',
        exportMode: 'bookmarks',
        outputFormat: 'csv'
    })`, harness.context);

    assert.equal(result.success, true);
    assert.equal(
        vm.runInContext(
            'rateLimiter !== globalThis.__primary && bookmarkContextRateLimiter === null && aboutRateLimiter === null',
            harness.context
        ),
        true
    );
}

async function testStopDuringContextWaitPreventsLaterRequest() {
    const harness = createWorkerHarness();
    setRunningExport(harness.context);
    vm.runInContext(`
        globalThis.__contextWait = enrichBookmarkReplyContexts([
            { id: '1', reply_to_id: '123', reply_to_post: null }
        ]);
        exportLoopPromise = globalThis.__contextWait.catch(() => {});
        waitForLoopUnwind = async () => {
            await Promise.race([
                exportLoopPromise,
                new Promise(resolve => setTimeout(resolve, 50))
            ]);
        };
    `, harness.context);
    const contextLimiter = harness.limiterInstances.at(-1);
    assert(contextLimiter?.pending, 'context limiter must be waiting before Stop');

    const startedAt = Date.now();
    const stopped = await vm.runInContext('stopExport()', harness.context);
    const elapsed = Date.now() - startedAt;
    if (!contextLimiter._aborted && contextLimiter.pending) {
        contextLimiter.pending.reject(new Error('ABORTED'));
        contextLimiter.pending = null;
    }
    await harness.context.__contextWait.catch(() => {});

    assert.equal(stopped.success, true);
    assert.equal(contextLimiter._aborted, true);
    assert.equal(harness.contextFetches(), 0);
    assert(elapsed < 1000, `Stop took ${elapsed}ms to unwind`);
}

const tests = [
    ['Stop aborts bookmark-context limiter', testStopAbortsBookmarkContextLimiter],
    ['status includes bookmark-context wait', testStatusUsesBookmarkContextWait],
    ['live pacing reconfigures bookmark-context limiter', testLivePacingReconfiguresBookmarkContextLimiter],
    ['terminal/error cleanup clears limiters', testTerminalAndErrorCleanupClearEveryLimiter],
    ['fresh run clears stale secondary limiters', testFreshRunClearsStaleSecondaryLimiters],
    ['Stop prevents a post-abort context request', testStopDuringContextWaitPreventsLaterRequest]
];

(async () => {
    const failures = [];
    for (const [name, test] of tests) {
        try {
            await test();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures.push({ name, error });
            console.error(`FAIL ${name}: ${error.message}`);
        }
    }
    if (failures.length > 0) process.exitCode = 1;
    else console.log('Bookmark-context lifecycle tests passed');
})();
