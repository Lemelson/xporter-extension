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
const crypto = require('node:crypto');
const feedbackPath = path.join(root, 'docs/feedback.html');
// The page CSP pins its inline <script>/<style> by hash. After editing either,
// refresh the meta with: node scripts/test-feedback-v2-compat.cjs --write-csp
function feedbackCsp(page) {
    const hash = text => "'sha256-" + crypto.createHash('sha256').update(text, 'utf8').digest('base64') + "'";
    const scripts = [...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => hash(m[1]));
    const styles = [...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => hash(m[1]));
    // POST and the JSONP receipt start at script.google.com and redirect to googleusercontent.
    const collector = 'https://script.google.com https://script.googleusercontent.com';
    return ["default-src 'none'", `script-src 'self' ${scripts.join(' ')} ${collector}`, `style-src 'self' ${styles.join(' ')}`,
        "img-src 'self'", "font-src 'self'", `connect-src ${collector}`, 'worker-src blob:', "base-uri 'none'",
        "form-action 'none'", "object-src 'none'"].join('; ');
}
const cspPattern = /<meta http-equiv="Content-Security-Policy" content="([^"]*)" \/>/;
if (process.argv.includes('--write-csp')) {
    const page = fs.readFileSync(feedbackPath, 'utf8');
    fs.writeFileSync(feedbackPath, page.replace(cspPattern, `<meta http-equiv="Content-Security-Policy" content="${feedbackCsp(page)}" />`));
}
const html = fs.readFileSync(feedbackPath, 'utf8');
assert.equal(html.match(cspPattern)?.[1], feedbackCsp(html),
    'feedback CSP is stale; run node scripts/test-feedback-v2-compat.cjs --write-csp');
assert(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'CSP must precede every script');
assert.equal(new URL(html.match(/const ENDPOINT = "([^"]+)"/)[1]).origin, 'https://script.google.com',
    'the collector endpoint must stay inside the CSP allowlist');
assert(!/\son[a-z]+=|\sstyle=|javascript:/i.test(html.replace(/<script[\s\S]*?<\/script>/gi, '')),
    'inline handlers/styles would be blocked by the CSP');
// URL parameters must never reach HTML parsing.
for (const match of html.matchAll(/innerHTML\s*=\s*([^;]+);/g)) assert(!/params|location|search/.test(match[1]), match[1]);
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
    // Legacy query values reach Sheets as strings and digit-only cells are parsed as numbers.
    assert.equal(legacy.exp_ok,7);
    const invalid = await record('?src=uninstall&d2=invalid');
    assert.equal(invalid.transport_error,1);
    console.log('Feedback compatibility: 83-field release, 81-field predecessor, legacy URL, malformed payload passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
