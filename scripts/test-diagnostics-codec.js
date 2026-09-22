#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ctx = vm.createContext({ TextEncoder, TextDecoder, CompressionStream, DecompressionStream,
    Response, Blob, btoa, atob, URL, URLSearchParams });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../utils/diagnostics-codec.js'), 'utf8'), ctx);
const codec = ctx.XPorterDiagnosticsCodec;
assert.equal(fs.readFileSync(path.join(__dirname, '../utils/diagnostics-codec.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../docs/assets/diagnostics-codec.js'), 'utf8'), 'website and extension codec must match');
const collector = require('./feedback-collector-harness.cjs').harness();
assert.deepEqual([...codec.fields], [...collector.ctx.STAT_FIELDS], 'transport and receiver field ordering must match');
async function run() {
    const stats = { schema_version: 2, v: '1.6.5', ui_lang: 'zh', exp_started: 17,
        diag_attempts: [{ mode: 'posts', format: 'xlsx', rows: 15, firstItemMs: null,
            result: 'stopped', settings: { includeReplies: true, exportSpeed: 'standard' } }],
        arbitrary: 'MUST_NOT_TRANSMIT' };
    const url = await codec.buildURL('https://lemelson.github.io/xporter-extension/feedback.html', stats);
    assert(url.length <= 1023);
    const restored = await codec.decode(new URL(url).searchParams.get('d2'));
    assert.equal(restored.ui_lang, 'zh');
    assert.equal(restored.exp_started, 17);
    assert.equal(restored.diag_attempts[0].firstItemMs, null);
    assert.equal(restored.diag_attempts[0].settings.includeReplies, true);
    assert(!JSON.stringify(restored).includes('MUST_NOT_TRANSMIT'));
    const crowded = { ...stats, diag_attempts: Array.from({length:5}, (_, i) => ({
        ...stats.diag_attempts[0], id:i+1, at:1800000000000+i*173189, version:'1.6.5',
        requests: i*139, rows:i*999, error:'NETWORK_TIMEOUT', settings:{ quantityLimit:i*3511 }
    })) };
    for (let i=0; i<codec.fields.length; i++) if (!(codec.fields[i] in crowded)) crowded[codec.fields[i]] = i*1129;
    const largeURL = await codec.buildURL('https://lemelson.github.io/xporter-extension/feedback.html', crowded);
    assert(largeURL.length <= 1023, `URL too long: ${largeURL.length}`);
    const largeRestored = await codec.decode(new URL(largeURL).searchParams.get('d2'));
    assert.equal((largeRestored.diag_attempts?.length || 0) + (largeRestored.transport_omitted_attempts || 0), 5);
    await assert.rejects(codec.decode('!malformed'));
    console.log('Diagnostics codec round trip, allowlist and URL limit passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
