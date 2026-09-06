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
    failFirstSet = false, history = [], failHistoryRead = false, usage = {}, failUsageRead = false
} = {}) {
    const stored = {
        [SETTINGS_KEY]: clone(initialSettings),
        xporter_export_history: clone(history),
        xporter_usage: clone(usage)
    };
    let setAttempts = 0;

    const context = vm.createContext({
        console: {
            log() {},
            warn() {},
            error() {}
        },
        XPORTER_CONFIG: {},
        chrome: {
            runtime: {
                getManifest: () => ({ permissions: ['unlimitedStorage'] })
            },
            storage: {
                local: {
                    async get(key) {
                        if (key === 'xporter_usage' && failUsageRead) {
                            failUsageRead = false;
                            throw new Error('simulated usage read rejection');
                        }
                        if (key === 'xporter_export_history' && failHistoryRead) {
                            failHistoryRead = false;
                            throw new Error('simulated history read rejection');
                        }
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
                        return 0;
                    },
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
        usage: () => clone(stored.xporter_usage)
    };
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
