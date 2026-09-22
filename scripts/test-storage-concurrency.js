#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SETTINGS_KEY = 'xporter_settings';
const storageSource = fs.readFileSync(path.join(ROOT, 'utils/storage.js'), 'utf8');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createStorageHarness(initialSettings, {
    failFirstSet = false, history = [], failHistoryRead = false, usage = {}, failUsageRead = false,
    extra = {}, failArrayRead = false, failStateRead = false, failSettingsRead = false,
    withGetKeys = false, permissions = ['unlimitedStorage']
} = {}) {
    const stored = {
        [SETTINGS_KEY]: clone(initialSettings),
        xporter_export_history: clone(history),
        xporter_usage: clone(usage),
        ...clone(extra)
    };
    let setAttempts = 0;
    const calls = { getAll: 0, getKeys: 0, getBytesInUse: 0 };

    const context = vm.createContext({
        console: {
            log() {},
            warn() {},
            error() {}
        },
        XPORTER_CONFIG: {},
        chrome: {
            runtime: {
                getManifest: () => ({ permissions })
            },
            storage: {
                local: {
                    async get(key) {
                        if (key === SETTINGS_KEY && failSettingsRead) {
                            throw new Error('simulated settings read rejection');
                        }
                        if (key === 'xporter_export_state' && failStateRead) {
                            throw new Error('simulated export state read rejection');
                        }
                        if (key === 'xporter_usage' && failUsageRead) {
                            failUsageRead = false;
                            throw new Error('simulated usage read rejection');
                        }
                        if (key === 'xporter_export_history' && failHistoryRead) {
                            failHistoryRead = false;
                            throw new Error('simulated history read rejection');
                        }
                        if (Array.isArray(key) && failArrayRead) {
                            throw new Error('simulated batch read rejection');
                        }
                        if (key === null) calls.getAll++;
                        const snapshot = clone(stored);
                        // Resolve on the next microtask. Without settings-write
                        // serialization, two concurrent callers both capture the
                        // same pre-write snapshot. With serialization, the second
                        // read cannot start until the first write has committed.
                        await new Promise(queueMicrotask);
                        if (key === null) return snapshot;
                        if (Array.isArray(key)) {
                            return Object.fromEntries(
                                key.filter(item => Object.hasOwn(snapshot, item))
                                    .map(item => [item, snapshot[item]])
                            );
                        }
                        return Object.hasOwn(snapshot, key)
                            ? { [key]: snapshot[key] }
                            : {};
                    },
                    async set(values) {
                        setAttempts++;
                        if (failFirstSet && setAttempts === 1) {
                            throw new Error('simulated storage rejection');
                        }
                        // Make the first patch yield so the unlocked baseline
                        // deterministically commits the second stale snapshot
                        // before the first one.
                        if (values[SETTINGS_KEY]?.language === 'ru') {
                            await new Promise(queueMicrotask);
                        }
                        Object.assign(stored, clone(values));
                    },
                    async remove(keys) {
                        for (const key of [].concat(keys)) delete stored[key];
                    },
                    async getBytesInUse() {
                        calls.getBytesInUse++;
                        return 0;
                    },
                    ...(withGetKeys ? {
                        async getKeys() {
                            calls.getKeys++;
                            return Object.keys(stored);
                        }
                    } : {}),
                    QUOTA_BYTES: 10 * 1024 * 1024
                }
            }
        }
    });

    vm.runInContext(storageSource, context, { filename: 'utils/storage.js' });
    return {
        storage: context.XPorterStorage,
        settings: () => clone(stored[SETTINGS_KEY]),
        history: () => clone(stored.xporter_export_history),
        usage: () => clone(stored.xporter_usage),
        stored: () => clone(stored),
        calls
    };
}

const BATCH = index => `xporter_tweets_batch_${index}`;
const EXPORT_STATE = 'xporter_export_state';

async function testBatchReadsNeverDegradeToEmptyData() {
    const complete = createStorageHarness({}, { extra: {
        [EXPORT_STATE]: { totalBatches: 2 },
        [BATCH(0)]: [{ id: '1' }],
        [BATCH(1)]: [{ id: '2' }]
    } });
    assert.deepEqual(clone(await complete.storage.loadTweetBatches(0, 2)), [[{ id: '1' }], [{ id: '2' }]]);
    assert.deepEqual(clone(await complete.storage.loadAllTweets()), [{ id: '1' }, { id: '2' }]);
    assert.deepEqual(clone(await complete.storage.loadTweetBatch(1)), [{ id: '2' }]);

    const gap = createStorageHarness({}, { extra: {
        [EXPORT_STATE]: { totalBatches: 2 },
        [BATCH(0)]: [{ id: '1' }]
    } });
    await assert.rejects(gap.storage.loadTweetBatches(0, 2), /STORAGE_READ_FAILED/,
        'a missing batch inside the saved range is a read failure, not an empty batch');
    await assert.rejects(gap.storage.loadAllTweets(), /STORAGE_READ_FAILED/,
        'history payloads must not silently drop a missing batch');
    await assert.rejects(gap.storage.loadTweetBatch(1), /STORAGE_READ_FAILED/);

    const rejected = createStorageHarness({}, {
        extra: { [EXPORT_STATE]: { totalBatches: 1 }, [BATCH(0)]: [{ id: '1' }] },
        failArrayRead: true
    });
    await assert.rejects(rejected.storage.loadTweetBatches(0, 1), /STORAGE_READ_FAILED/);
    await assert.rejects(rejected.storage.loadAllTweets(), /STORAGE_READ_FAILED/);

    const rejectedState = createStorageHarness({}, {
        extra: { [EXPORT_STATE]: { totalBatches: 1 }, [BATCH(0)]: [{ id: '1' }] },
        failStateRead: true
    });
    await assert.rejects(rejectedState.storage.loadExportState(), /STORAGE_READ_FAILED/,
        'a failed state read must be distinguishable from no saved export');
    await assert.rejects(rejectedState.storage.loadAllTweets(), /STORAGE_READ_FAILED/,
        'a failed initial state read must not yield an empty successful history payload');
    assert.equal(await createStorageHarness({}).storage.loadExportState(), null,
        'a genuinely missing export state still means no saved export');
}

async function testActiveTimeTicksAreBounded() {
    const harness = createStorageHarness({}, { usage: { activeMs: 1000 } });
    for (const invalid of [NaN, Infinity, -5000, 0, '5000', null, undefined]) {
        await harness.storage.addActiveMs(invalid);
    }
    assert.equal(harness.usage().activeMs, 1000, 'invalid active-time values must be ignored');
    await harness.storage.addActiveMs(2500);
    assert.equal(harness.usage().activeMs, 3500);
    await harness.storage.addActiveMs(24 * 60 * 60 * 1000);
    assert.equal(harness.usage().activeMs, 3500 + 5 * 60 * 1000,
        'one tick can add at most five minutes');
}

async function testFailedSettingsReadCannotExpireRetainedHistory() {
    const history = [{ id: 'keep', completedAt: 1, items: [{ id: 'row' }], hasData: true }];
    const harness = createStorageHarness({ autoExpireEnabled: false }, {
        history, failSettingsRead: true
    });
    await assert.rejects(harness.storage.loadSettings(), /STORAGE_READ_FAILED/,
        'a failed settings read must not pretend the default expiry preference was saved');
    await assert.rejects(harness.storage.pruneExpiredExportHistory(undefined, 20_000_000),
        /STORAGE_READ_FAILED/, 'expiry must stop when preferences cannot be read');
    assert.deepEqual(harness.history(), history, 'retained rows must survive the settings read failure');
}

async function testExportCleanupListsKeysWithoutLoadingValues() {
    const extra = {
        [EXPORT_STATE]: { totalBatches: 1 },
        [BATCH(0)]: [{ id: '1' }],
        [BATCH(7)]: [{ id: 'stranded' }]
    };
    const modern = createStorageHarness({}, { extra, withGetKeys: true });
    assert.equal(await modern.storage.clearExportState(), true);
    assert.equal(modern.calls.getKeys, 1);
    assert.equal(modern.calls.getAll, 0, 'getKeys must replace the full get(null) load');
    assert.deepEqual(Object.keys(modern.stored()).filter(key => key.startsWith('xporter_tweets_')
        || key === EXPORT_STATE), []);

    const legacy = createStorageHarness({}, { extra });
    assert.equal(await legacy.storage.clearExportState(), true);
    assert.equal(legacy.calls.getAll, 1, 'Chrome before 130 keeps the get(null) sweep');
    assert.equal(legacy.stored()[BATCH(7)], undefined);
}

async function testUnlimitedStorageSkipsByteCounting() {
    const unlimited = createStorageHarness({});
    assert.equal((await unlimited.storage.checkStorageQuota()).isWarning, false);
    assert.equal(unlimited.calls.getBytesInUse, 0,
        'unlimitedStorage has no quota, so the byte count is never requested');

    const limited = createStorageHarness({}, { permissions: [] });
    await limited.storage.checkStorageQuota();
    assert.equal(limited.calls.getBytesInUse, 1);
}

async function testConcurrentPartialPatchesAreMerged() {
    const harness = createStorageHarness({
        theme: 'dark',
        includeReplies: false,
        profileFeed: 'posts',
        hiddenFutureSetting: 'preserve-me'
    });

    const results = await Promise.all([
        harness.storage.saveSettings({ language: 'ru' }),
        harness.storage.saveSettings({ theme: 'light' })
    ]);

    assert.deepEqual(results, [true, true]);
    assert.equal(harness.settings().language, 'ru');
    assert.equal(harness.settings().theme, 'light');
    assert.equal(harness.settings().hiddenFutureSetting, 'preserve-me');
    assert.equal(harness.settings().profileFeed, undefined);
    assert.equal(harness.settings().postSelectionVersion, 1);
}

async function testRejectedWriteDoesNotPoisonLaterPatch() {
    const harness = createStorageHarness(
        {
            theme: 'dark',
            hiddenFutureSetting: 'preserve-me'
        },
        { failFirstSet: true }
    );

    const results = await Promise.all([
        harness.storage.saveSettings({ language: 'ru' }),
        harness.storage.saveSettings({ theme: 'light' })
    ]);

    assert.deepEqual(results, [false, true]);
    assert.equal(harness.settings().language, undefined);
    assert.equal(harness.settings().theme, 'light');
    assert.equal(harness.settings().hiddenFutureSetting, 'preserve-me');
}

(async () => {
    await testConcurrentPartialPatchesAreMerged();
    await testRejectedWriteDoesNotPoisonLaterPatch();
    await testBatchReadsNeverDegradeToEmptyData();
    await testFailedSettingsReadCannotExpireRetainedHistory();
    await testActiveTimeTicksAreBounded();
    await testExportCleanupListsKeysWithoutLoadingValues();
    await testUnlimitedStorageSkipsByteCounting();
    const concurrent = createStorageHarness({});
    await Promise.all([
        concurrent.storage.saveExportHistory({ username: 'first' }),
        concurrent.storage.saveExportHistory({ username: 'second' })
    ]);
    assert.deepEqual(concurrent.history().map(entry => entry.username), ['second', 'first'],
        'concurrent completed exports must both survive');

    const clearing = createStorageHarness({}, { history: [{ id: 'old' }] });
    await Promise.all([
        clearing.storage.saveExportHistory({ username: 'new' }),
        clearing.storage.clearExportHistory()
    ]);
    assert.deepEqual(clearing.history(), [], 'Clear must run after an already requested save');

    const pruning = createStorageHarness({}, {
        history: [{ id: 'old', completedAt: 1, items: [{ id: 'row' }], hasData: true }]
    });
    await Promise.all([
        pruning.storage.pruneExpiredExportHistory({ autoExpireHours: 1 }, 10_000_000),
        pruning.storage.deleteExportHistoryEntry('old')
    ]);
    assert.deepEqual(pruning.history(), [], 'expiry must not resurrect a deleted entry');

    const failedRead = createStorageHarness({}, { history: [{ id: 'keep' }], failHistoryRead: true });
    await assert.rejects(failedRead.storage.saveExportHistory({ username: 'lost' }), /history read rejection/);
    assert.deepEqual(failedRead.history(), [{ id: 'keep' }], 'failed read must never overwrite history');
    await failedRead.storage.saveExportHistory({ username: 'after failure' });
    assert.equal(failedRead.history().length, 2, 'a rejected transaction must not poison the history queue');

    const squashes = createStorageHarness({}, { usage: { opens: 42 } });
    await Promise.all(Array.from({ length: 20 }, () => squashes.storage.recordLadybugSquash()));
    assert.equal((await squashes.storage.loadUsage()).ladybugSquashes, 20);
    assert.equal(squashes.usage().opens, 42);

    const usageFailure = createStorageHarness({}, {
        usage: { opens: 42, downloads: 17 }, failUsageRead: true
    });
    await assert.rejects(usageFailure.storage.recordOpen(), /usage read rejection/);
    assert.deepEqual(usageFailure.usage(), { opens: 42, downloads: 17 },
        'failed counter reads must not reset previously collected counters');
    await usageFailure.storage.recordOpen();
    assert.equal(usageFailure.usage().opens, 43);
    assert.equal(usageFailure.usage().downloads, 17);
    console.log('Storage concurrency tests passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
