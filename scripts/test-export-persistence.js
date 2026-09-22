#!/usr/bin/env node
// Rows counted in the UI must exist on disk. Regression tests for the
// "Accounts collected: 48" / "No data to download" family of bugs.

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createWorkerHarness, setRunningExport, setLimiterBindings } = require('./test-bookmark-context-lifecycle.js');

const noopLimiter = () => ({ abort() {}, getState() { return {}; }, waitUntil: 0 });

function instrumentStorage(harness) {
    const writes = { batches: [], states: [] };
    const storage = harness.context.XPorterStorage;
    storage.saveTweetBatch = async (index, rows) => { writes.batches.push({ index, rows: rows.slice() }); return true; };
    storage.saveExportState = async (state) => { writes.states.push({ ...state }); return true; };
    return writes;
}

async function testErrorPathFlushesBuffer() {
    const harness = createWorkerHarness();
    const writes = instrumentStorage(harness);
    setRunningExport(harness.context, {
        exportMode: 'followers', tweetCount: 48, totalBatches: 0,
        tweetBuffer: Array.from({ length: 48 }, (_, i) => ({ id: String(i) }))
    });
    setLimiterBindings(harness.context, noopLimiter(), noopLimiter(), noopLimiter());
    vm.runInContext('runExportLoop = async () => { throw new Error("RATE_LIMITED"); }', harness.context);
    await vm.runInContext('launchExportLoop("test:"); exportLoopPromise', harness.context);

    assert.equal(writes.batches.length, 1, 'the 48 buffered rows must be written when the loop dies');
    assert.equal(writes.batches[0].rows.length, 48);
    const final = writes.states.at(-1);
    assert.equal(final.status, 'error');
    assert.equal(final.error, 'RATE_LIMITED');
    assert.equal(final.totalBatches, 1, 'persisted batch count must include the flushed rows');
    assert.equal(final.tweetCount, 48, 'persisted count must equal rows on disk');
}

async function testPersistedCountExcludesUnflushedRows() {
    const harness = createWorkerHarness();
    const writes = instrumentStorage(harness);
    setRunningExport(harness.context, {
        exportMode: 'followers', tweetCount: 130, totalBatches: 2,
        tweetBuffer: Array.from({ length: 30 }, (_, i) => ({ id: String(i) }))
    });
    // A live-settings save lands mid-page (the only saveCurrentState with no flush before it).
    await vm.runInContext('saveCurrentState({ bestEffort: true })', harness.context);
    const saved = writes.states.at(-1);
    assert.equal(saved.totalBatches, 2);
    assert.equal(saved.tweetCount, 100, 'a mid-page save must not count rows that are still only in memory');
    assert.equal(vm.runInContext('currentExport.tweetCount', harness.context), 130, 'the live counter shown in the popup stays untouched');
}

async function testStatusRepairClampsOrphanCount() {
    const harness = createWorkerHarness();
    const writes = instrumentStorage(harness);
    harness.context.XPorterStorage.loadExportState = async () => ({
        running: false, status: 'error', error: 'RATE_LIMITED', tweetCount: 48, totalBatches: 0,
        exportMode: 'followers', userId: 'u1', settings: {}
    });
    vm.runInContext('currentExport = null', harness.context);
    const status = await vm.runInContext('getExportStatus()', harness.context);
    assert.equal(status.tweetCount, 0, 'a count with no batches behind it must not promise a download');
    assert.equal(writes.states.at(-1)?.tweetCount, 0, 'the repaired count must be persisted');
}

const tests = [
    ['loop error flushes buffered rows before saving state', testErrorPathFlushesBuffer],
    ['mid-page state save persists only rows on disk', testPersistedCountExcludesUnflushedRows],
    ['status repair clamps a count that has no batches', testStatusRepairClampsOrphanCount]
];

(async () => {
    let failed = false;
    for (const [name, test] of tests) {
        try { await test(); console.log(`PASS ${name}`); }
        catch (error) { failed = true; console.error(`FAIL ${name}: ${error.message}`); }
    }
    if (failed) process.exitCode = 1; else console.log('Export persistence tests passed');
})();
