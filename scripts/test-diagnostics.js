#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '..');
function harness(seed = {}) {
    const data = structuredClone(seed);
    let now = 1800000000000;
    const context = vm.createContext({
        console, crypto: webcrypto, structuredClone, setTimeout, clearTimeout,
        Date: class extends Date { static now() { return now; } },
        chrome: { runtime: { getManifest: () => ({ version: '1.6.5' }) }, storage: { local: {
            get: async key => ({ [key]: structuredClone(data[key]) }),
            set: async values => Object.assign(data, structuredClone(values))
        } } },
        XPorterStorage: { loadUsage: async () => ({ installedAt: now - 50000, exportsStarted: 12 }) }
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'utils/diagnostics.js'), 'utf8'), context);
    return { api: context.XPorterDiagnostics, data, advance: ms => { now += ms; } };
}
async function run() {
    const h = harness({ xporter_usage: { exportsStarted: 12, itemsTotal: 400 } });
    const legacy = structuredClone(h.data.xporter_usage);
    await h.api.record('attempt', { mode: 'posts', format: 'xlsx', settings: { includeReplies: true, username: 'PRIVATE' } });
    await h.api.record('started');
    h.advance(1400);
    await h.api.record('progress', { rows: 25 });
    h.advance(1000);
    await h.api.record('terminal', { result: 'stopped', rows: 25 });
    await h.api.record('attempt', { mode: 'followers', format: 'csv' });
    await h.api.record('terminal', { result: 'rejected', error: 'INVALID_DATE_RANGE' });
    const state = await h.api.load();
    assert.deepEqual(h.data.xporter_usage, legacy, 'legacy counters must never be rewritten');
    assert.equal(state.schema, 2);
    assert.equal(state.attempts[0].rows, 25, 'partial rows survive Stop');
    assert.equal(state.attempts[0].firstItemMs, 1400);
    assert.equal(state.attempts[1].firstItemMs, null, 'missing latency is not zero');
    assert.equal(state.attempts[1].error, 'INVALID_DATE_RANGE');
    assert.equal(state.attempts[0].error, '', 'errors belong to their own attempt');
    assert(!JSON.stringify(state).includes('PRIVATE'), 'unknown personal fields cannot enter diagnostics');
    assert.equal(state.totals.rejected, 1);
    const id = await h.api.record('download_begin', { mode: 'posts', format: 'xlsx', source: 'current', rows: 25, parts: 2 });
    await h.api.record('download_file', { id, downloadId: 9, bytes: 100 });
    await h.api.record('download_file', { id, downloadId: 10, bytes: 200 });
    await h.api.record('download_handoff', { id });
    assert.equal((await h.api.load()).totals.downloadComplete, 0, 'downloadId is not completion');
    await h.api.record('download_state', { downloadId: 9, state: 'complete' });
    await h.api.record('download_state', { downloadId: 9, state: 'complete' });
    assert.equal((await h.api.load()).totals.downloadComplete, 0, 'duplicate file events cannot complete multipart');
    await h.api.record('download_state', { downloadId: 10, state: 'complete' });
    assert.equal((await h.api.load()).totals.downloadComplete, 1);
    const stoppedId = await h.api.record('download_begin', { parts: 1 });
    await h.api.record('download_file', { id: stoppedId, downloadId: 11 });
    await h.api.record('download_state', { downloadId: 11, state: 'interrupted', error: 'USER_CANCELED' });
    await h.api.record('download_handoff', { id: stoppedId });
    assert.equal((await h.api.load()).downloads.at(-1).result, 'interrupted');
    assert.equal((await h.api.load()).totals.downloadComplete, 1);
    await h.api.record('attempt', { mode: 'posts' });
    await h.api.record('started');
    const active = (await h.api.load()).currentAttempt;
    for (let i = 0; i < 9; i++) await h.api.record('rejected', { error: 'ALREADY_RUNNING' });
    assert.equal((await h.api.load()).attempts.length, 5);
    assert((await h.api.load()).attempts.some(row => row.id === active));
    await h.api.record('recover');
    assert.equal((await h.api.load()).totals.interrupted, 1);
    const before = (await h.api.load()).totals.requests;
    await Promise.all(Array.from({length: 30}, () => h.api.record('metric', {key:'requests', attemptId:active})));
    assert.equal((await h.api.load()).totals.requests, before + 30, 'concurrent counter writes serialize');
    const failuresBefore = (await h.api.load()).totals.downloadFailed;
    for (let i = 0; i < 7; i++) await h.api.record('download_begin', {parts:1});
    assert.equal((await h.api.load()).totals.downloadFailed, failuresBefore, 'evicted tracking is not a failed download');
    assert((await h.api.load()).totals.downloadUnknown > 0);
    console.log('Diagnostics lifecycle and legacy preservation passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
