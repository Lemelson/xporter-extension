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

function createStorageHarness(initialSettings, { failFirstSet = false } = {}) {
    const stored = { [SETTINGS_KEY]: clone(initialSettings) };
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
        settings: () => clone(stored[SETTINGS_KEY])
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
    console.log('Storage concurrency tests passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
