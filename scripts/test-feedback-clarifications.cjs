'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { harness } = require('./feedback-collector-harness.cjs');
const html = fs.readFileSync('docs/feedback.html', 'utf8');
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
class Element {
  constructor() { this.children = []; this.attributes = {}; this.dataset = {}; this.value = ''; this.hidden = false;
    this.classList = {add() {}}; this.listeners = {}; }
  set innerHTML(value) { this.children = []; this.markup = value; }
  get innerHTML() { return this.markup; }
  querySelector() { return this.label ||= new Element(); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  appendChild(child) { this.children.push(child); }
}
function page(storage = new Map()) {
  const nodes = Object.fromEntries(['detail','formatBlock','formatOptions','subreasonPrompt','subreasonBlock','subreasonOptions','action'].map(id => [id, new Element()]));
  const sent = [];
  const context = vm.createContext({ document: { getElementById: id => nodes[id], createElement: () => new Element() },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key,value) => storage.set(key,value) },
    feedbackSessionStorageKey: 'fixture-session', sessionId: 'fixture-session', safeSource:'uninstall', params:{},
    lang:'ru', languageSource:'extension', pageOpenedAt:'2026-09-30T10:00:00Z',
    forwardedAnonymousStats: () => ({v:'2.0.1',s_format:'csv',f_csv:2,f_json:0}), pageSeconds: () => 4,
    send: payload => { sent.push(payload); }, actionEl: nodes.action,
    subreasonBlockEl:nodes.subreasonBlock, subreasonOptionsEl:nodes.subreasonOptions });
  vm.runInContext(between('    const I18N = {', '    /* ---------------- helpers ---------------- */'), context);
  vm.runInContext('function t(key) { return I18N[lang][key] || I18N.en[key] || key; }', context);
  vm.runInContext(between('    let selectedReason = null;', '    let reasonTransitioning = false;'), context);
  vm.runInContext(between('    function setSubreason(key) {','    // contact links'), context);
  vm.runInContext(between('    function basePayload(includeFeedbackState) {','    document.addEventListener("visibilitychange"'), context);
  vm.runInContext(between('    function composeDetail(manualDetail) {','    document.getElementById("submitBtn").addEventListener'), context);
  const run = code => vm.runInContext(code, context);
  function reason(key) { run(`selectedReason=${JSON.stringify(key)}; if (!selectedSubreasonsByReason.has(selectedReason)) selectedSubreasonsByReason.set(selectedReason,new Set()); selectedSubreasons=selectedSubreasonsByReason.get(selectedReason); if (!reasonHistory.includes(selectedReason)) reasonHistory.push(selectedReason); persistFeedbackState(); renderSubreasons();`); }
  function click(key) {
    const button = [...nodes.subreasonOptions.children, ...nodes.formatOptions.children].find(b => b.dataset.subreason === key);
    assert(button, `${key} must be visible and actionable`); button.listeners.click(); return button;
  }
  return {run,reason,click,nodes,sent,storage};
}
const p = page();
const localeKeys = p.run('Object.keys(I18N)');
assert.equal(localeKeys.length,14);
for (const language of localeKeys) for (const key of ['subreasonHint','formatPrompt','sr_broken_window_unusable','sr_broken_download_failed','sr_broken_did_not_finish', ...p.run('FORMAT_SUBREASONS')]) {
  assert(p.run(`Boolean(I18N[${JSON.stringify(language)}][${JSON.stringify(key)}])`), `${language}/${key} must have local copy`);
}
assert(html.includes('id="formatOptions" role="group" aria-labelledby="formatPrompt" aria-describedby="subreasonHint"'));
assert(!/<textarea[^>]*required/.test(html), 'free text stays optional');
p.reason('r_missing'); assert(p.nodes.formatBlock.hidden);
p.click('sr_missing_different_format'); assert(!p.nodes.formatBlock.hidden);
assert.equal(p.nodes.formatOptions.children.length,8);
const pdf = p.click('sr_missing_format_pdf'); assert.equal(pdf.attributes['aria-pressed'],'true');
p.click('sr_missing_format_html'); p.click('sr_missing_format_other');
const payload = p.run('basePayload()');
assert.equal(payload.stats.subreasons,'sr_missing_different_format | sr_missing_format_pdf | sr_missing_format_html | sr_missing_format_other');
assert.equal(payload.stats.subreason_labels,'Needed a different file format | PDF | HTML | Other format', 'labels stay canonical EN in a Russian UI');
assert.equal(payload.stats.form_version,3);
assert.equal(payload.stats.s_format,'csv'); assert.equal(payload.stats.f_csv,2); assert.equal(payload.stats.f_json,0);
const collector = harness();
assert(collector.post({...payload,type:'reason',reason:'r_missing',feedback_seq:1}).ok);
let row = Object.fromEntries(collector.sheets.Sheet1.rows[0].map((key,i) => [key,collector.sheets.Sheet1.rows[2][i]]));
assert.equal(row.subreasons,payload.stats.subreasons); assert.equal(row.subreason_labels,payload.stats.subreason_labels);
assert.equal(row.form_version,3, 'the existing numeric column distinguishes this question revision');
assert.equal(row.s_format,'csv'); assert.equal(row.f_csv,2);
assert(!collector.sheets.Sheet1.rows[0].includes('requested_format'), 'no new column contract');
p.reason('r_broken'); assert(p.nodes.formatBlock.hidden); assert.equal(p.nodes.formatOptions.children.length,0);
p.click('sr_broken_window_unusable'); p.click('sr_broken_did_not_finish'); p.click('sr_broken_download_failed');
let switched = p.run('basePayload()');
assert(!switched.stats.subreasons.includes('format_pdf'), 'hidden choices cannot become the active broken answer');
assert(switched.stats.subreasons_all.includes('sr_missing_format_pdf'), 'history preserves another reason’s answers');
assert.equal(switched.stats.reason_history,'r_missing | r_broken');
assert(switched.stats.subreasons.includes('sr_broken_did_not_finish'));
assert(switched.stats.subreason_labels.includes('Export never finished'));
assert(!switched.stats.subreasons.includes('sr_broken_stopped_midway'), 'an unfinished or hung export is distinct from a stopped export');
p.reason('r_missing'); assert(!p.nodes.formatBlock.hidden);
assert.equal(p.nodes.formatOptions.children[0].attributes['aria-pressed'],'true','returning restores visible choices');
p.click('sr_missing_different_format'); assert(p.nodes.formatBlock.hidden);
assert(!p.run('basePayload().stats.subreasons_all').includes('format_pdf'),'deselecting parent clears stale format requests');
p.click('sr_missing_different_format');
assert.equal(p.nodes.formatOptions.children[0].attributes['aria-pressed'],'false');
p.click('sr_missing_format_json');
p.nodes.detail.value='Optional note'; p.nodes.detail.listeners.input();
const reloaded = page(p.storage); reloaded.run('restoreFeedbackState(); renderSubreasons();');
assert.equal(reloaded.nodes.detail.value,'Optional note');
assert.equal(reloaded.run('selectedReason'),'r_missing');
assert.equal(reloaded.nodes.formatOptions.children.find(b => b.dataset.subreason==='sr_missing_format_json').attributes['aria-pressed'],'true');
assert.equal(reloaded.run('basePayload().stats.reason_history'),'r_missing | r_broken');
const detail = reloaded.run('composeDetail("")');
assert(detail.includes('JSON') && detail.includes('Could not download the file'));
assert(collector.post({...reloaded.run('basePayload()'),type:'detail',reason:'r_missing',detail,feedback_seq:2}).ok);
row = Object.fromEntries(collector.sheets.Sheet1.rows[0].map((key,i) => [key,collector.sheets.Sheet1.rows[2][i]]));
assert.equal(row.detail, detail); assert.equal(row.reason_history,'r_missing | r_broken');
assert(row.subreasons.includes('sr_missing_format_json')); assert(!row.subreasons.includes('format_pdf'));
// Corrupted reload state must neither resurrect hidden formats nor inject unknown IDs.
p.storage.set('fixture-session:answers', JSON.stringify({reason:'r_missing',groups:[['r_missing',['sr_missing_format_pdf','unknown']]],history:['r_missing','unknown']}));
const stale = page(p.storage); stale.run('restoreFeedbackState(); renderSubreasons();');
assert(stale.nodes.formatBlock.hidden); assert.equal(stale.run('basePayload().stats.subreasons'),'none');
assert.equal(stale.run('basePayload().stats.reason_history'),'r_missing');
assert.deepEqual(Array.from(p.run('SUBREASON_OPTIONS.r_broken')), ['sr_broken_window_unusable','sr_broken_did_not_start','sr_broken_did_not_finish','sr_broken_stopped_midway','sr_broken_download_failed','sr_broken_empty_or_incomplete','sr_broken_wrong_data','sr_broken_error_message']);
assert(p.run('SUBREASON_OPTIONS.r_broken').includes('sr_broken_stopped_midway'));
// Every possible canonical label plus the textarea maximum must fit the collector's
// 4000-character detail contract, preserving the entire manual answer at the end.
const fullest = page();
fullest.run(`REASON_KEYS.forEach(reason => selectedSubreasonsByReason.set(reason,
  new Set(SUBREASON_OPTIONS[reason].concat(reason === 'r_missing' ? FORMAT_SUBREASONS : []))))`);
const manual = 'я'.repeat(2000);
const fullDetail = fullest.run(`composeDetail(${JSON.stringify(manual)})`);
assert(fullDetail.length <= 4000, `all chips plus manual text use ${fullDetail.length}/4000 characters`);
assert(fullDetail.endsWith(manual));
assert(collector.post({sessionId:'full-detail',source:'uninstall',type:'detail',reason:'r_missing',detail:fullDetail,feedback_seq:1,stats:{form_version:3}}).ok);
const fullestRow = Object.fromEntries(collector.sheets.Sheet1.rows[0].map((key,i) => [key,collector.sheets.Sheet1.rows[3][i]]));
assert.equal(fullestRow.detail,fullDetail,'collector must preserve the complete manual answer and summary');
// A POST may reach Sheets even if its opaque response is lost. The actual page
// sender must use the matching receipt for explicit Send in both transport paths.
async function responseLost(postCompletes, receiptAccepted, type = 'detail') {
  let receiptCalls = 0;
  const context = vm.createContext({
    ENDPOINT:'https://script.google.com/fixture', previewMode:false,
    feedbackSequence:0, feedbackSessionStorageKey:'fixture',
    sessionStorage:{setItem() {}}, crypto:{randomUUID:()=>'fixture-receipt-token'},
    AbortController, setTimeout, clearTimeout,
    fetch:(_url, options)=>{
      assert.equal(JSON.parse(options.body).test,true);
      return postCompletes ? Promise.resolve({type:'opaque'}) : Promise.reject(new Error('Response lost after write'));
    },
    XPorterFeedbackReceipt:{check:(endpoint,session,receipt,test)=>{
      receiptCalls++;
      assert.equal(endpoint,'https://script.google.com/fixture');
      assert.equal(session,'response-lost'); assert.equal(receipt,'fixture-receipt-token'); assert.equal(test,true);
      return Promise.resolve(receiptAccepted);
    }}
  });
  vm.runInContext(between('    function send(payload) {','    const actionCollapsedFrame = {'),context);
  const result = await context.send({sessionId:'response-lost',test:true,type,stats:{}});
  assert.equal(result,type === 'detail' ? receiptAccepted : postCompletes);
  assert.equal(receiptCalls,type === 'detail' ? 1 : 0);
}
(async()=>{
  await responseLost(false,true);
  await responseLost(false,false);
  await responseLost(true,true);
  await responseLost(true,false);
  await responseLost(false,true,'open');
  console.log('Feedback clarifications passed: 14 locales, stable collector columns, switching, cleanup, reload and receipts after lost POST responses.');
})().catch(error=>{console.error(error);process.exitCode=1;});
