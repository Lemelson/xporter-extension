const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const {harness} = require('./feedback-collector-harness.cjs');
const root = path.join(__dirname, '..');
const ctx = vm.createContext({Blob, Response, CompressionStream, DecompressionStream, TextDecoder, Uint8Array, btoa, atob});
vm.runInContext(fs.readFileSync(path.join(root, 'docs/assets/diagnostics-codec.js'), 'utf8'), ctx);
const codec = ctx.XPorterDiagnosticsCodec;
const html = fs.readFileSync(path.join(root, 'docs/feedback.html'), 'utf8');
const helpers = html.slice(html.indexOf('    const params = Object.fromEntries(new URLSearchParams(location.search));'), html.indexOf('    const isLocalFeedbackPage'));
async function record(search) {
    const page = vm.createContext({URLSearchParams, location: {search}, XPorterDiagnosticsCodec: codec});
    const stats = await vm.runInContext('(async()=>{' + helpers + ';return forwardedAnonymousStats()})()', page);
    const h = harness();
    assert(h.post({sessionId:'compat-test', source:'uninstall', type:'open', stats}).ok);
    return Object.fromEntries(h.sheets.Sheet1.rows[0].map((k,i)=>[k,h.sheets.Sheet1.rows[2][i]]));
}
(async()=>{
    // Frozen 2.0.0 wire positions: independent of the receiving codec's field list.
    const wire = Array(83).fill(null);
    wire[0]=2; wire[1]='2.0.0'; wire[3]=4; wire[5]='ja'; wire[6]='dark'; wire[10]=7;
    wire[52]=[]; wire[53]=[]; wire[54]=[]; wire[81]=3; wire[82]='obsidian';
    const encode = values => zlib.deflateSync(JSON.stringify(values)).toString('base64url');
    const row = await record('?src=uninstall&ui_lang=ja&d2='+encode(wire));
    assert.equal(row.v, '2.0.0', 'Released 83-field payload must preserve version');
    assert.equal(row.exp_ok, 7);
    assert.equal(row.theme_preset, 'obsidian');
    assert.equal(row.ladybug_squashes, 3);
    assert(!row.transport_error);
    const older = await record('?src=uninstall&d2='+encode(wire.slice(0,81)));
    assert.equal(older.exp_ok,7);
    const legacy = await record('?src=uninstall&v=1.6.5&exp_ok=7');
    assert.equal(legacy.v,'1.6.5');
    assert.equal(legacy.exp_ok,'7');
    const invalid = await record('?src=uninstall&d2=invalid');
    assert.equal(invalid.transport_error,'1');
    console.log('Feedback compatibility: 83-field release, 81-field predecessor, legacy URL, malformed payload passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
