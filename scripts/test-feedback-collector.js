#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {harness,oldRows,BOUND_ID,Formula}=require('./feedback-collector-harness.cjs');
const source=fs.readFileSync(path.join(__dirname,'../backend/apps-script.gs'),'utf8');
assert(!/[A-Za-z0-9_-]{40,}/.test(source.replace(/https?:\/\/\S+/g,'')),'no workbook ID literal in the collector');
assert(!/source === 'usage'|'Usage' :/.test(source),'abandoned usage telemetry has no write path');

const h=harness();
const health=h.ctx.doGet();
assert.deepEqual(Object.keys(health).sort(),['collector_version','ok','service','time'],'health reveals no workbook details');
assert.equal(health.ok,true);
const setup=h.ctx.setupTelemetrySchema();
assert.deepEqual(Object.keys(setup).sort(),['collector_version','ok','service','time']);
assert.deepEqual(h.sheets.Sheet1.rows,oldRows,'setup must not edit legacy rows or headers');
const event={sessionId:'test-new',source:'uninstall',type:'open',stats:{schema_version:2,installed_at:'2026-09-01T00:00:00Z',diag_attempts:[{mode:'posts',result:'stopped',rows:25,firstItemMs:null}],s_safety:'3_20'}};
const response=h.post(event);
assert.deepEqual(response,{ok:true,collector_version:2},'write response carries no sheet name or ID');
const rowOf=(sheet,id)=>{
  const rows=h.sheets[sheet].rows, column=rows[0].indexOf('sessionId');
  const row=rows.find((line,i)=>i>0 && line[column]===id);
  return Object.fromEntries(rows[0].map((key,i)=>[key,row[i]??'']));
};
const getNew=()=>rowOf('Sheet1','test-new');
const first=getNew();
assert.equal(first.schema_version,2);
assert.equal(first.last_attempt_rows,25);
assert.equal(first.s_safety,'3_20');
assert(h.post({...event,type:'detail',reason:'r_broken',detail:'=IMPORTXML("https://invalid")',receipt_id:'receipt-verified-123',feedback_seq:2,stats:{...event.stats,page_s:10}}).ok);
assert(h.post({...event,type:'reason',reason:'r_slow',feedback_seq:1,stats:{...event.stats,page_s:3}}).ok);
const updated=getNew();
assert.equal(updated.reason,'r_broken','delayed events cannot overwrite newer feedback');
assert.equal(updated.lastType,'detail');
assert.equal(updated.received,first.received);
assert.equal(updated.first_received,first.first_received);
assert.equal(updated.page_s,10);
assert.equal(updated.detail,'=IMPORTXML("https://invalid")','free text is stored literally, never executed as a formula');
assert.equal(h.ctx.findReceipt('test-new','receipt-verified-123').ok,true);
assert.equal(h.ctx.findReceipt('test-new','wrong-receipt').ok,false);
assert(h.post({...event,type:'detail',reason:'r_other',detail:'',receipt_id:'receipt-cleared-123',feedback_seq:3}).ok);
assert.equal(getNew().detail,'','resubmitting an explicitly cleared comment must remove the old text');
assert.equal(h.ctx.findReceipt('test-new','receipt-cleared-123').ok,true);
assert.deepEqual(h.sheets.Sheet1.rows[1].slice(0,oldRows[0].length),oldRows[1]);

// Formula injection through the upsert: every later pagehide/visibilitychange
// packet re-reads the row with getValues() (apostrophe stripped) and rewrites it.
const hostile=['=IMAGE("https://evil")','+1','-2','@x','\t=1',' =1','\r=1'];
hostile.forEach((detail,i)=>{
  const id='formula-'+i;
  assert(h.post({sessionId:id,source:'uninstall',type:'detail',reason:'r_other',detail,feedback_seq:1,
    pageLang:detail,stats:{schema_version:2,last_err:detail,page_s:4,subreasons:detail}}).ok);
  for (let repeat=0;repeat<3;repeat++) assert(h.post({sessionId:id,source:'uninstall',stats:{schema_version:2,page_s:5+repeat}}).ok);
  const row=rowOf('Sheet1',id);
  for (const key of ['detail','pageLang','last_err','subreasons']) {
    assert.equal(row[key],key==='pageLang' ? detail.slice(0,16) : detail,`${JSON.stringify(detail)} in ${key} stays literal text after repeated merges`);
  }
  assert.equal(row.page_s,7,'numeric counters stay numeric');
});
for (const sheet of Object.values(h.sheets)) for (const line of sheet.rows) for (const cell of line) {
  assert(!(cell instanceof Formula),`no formula cell may be produced: ${cell && cell.source}`);
}
const legacyNumbers=h.post({sessionId:'numeric-legacy',source:'uninstall',type:'open',stats:{exp_ok:'7',v:'1.6.5'}});
assert(legacyNumbers.ok);
assert.equal(rowOf('Sheet1','numeric-legacy').exp_ok,7,'numeric URL stats keep Sheets number parsing');
assert.equal(rowOf('Sheet1','numeric-legacy').v,'1.6.5');
// Delayed packets must not roll back any cells belonging to the URL snapshot.
const snapshotEvent={sessionId:'snapshot-order',source:'uninstall',type:'open',stats:{schema_version:2,
  snapshot_at:'2026-09-29T12:00:00Z',diag_revision:8,s_colorful:1,exp_started:8,
  diag_totals:{attempts:8},diag_attempts:[{mode:'bookmarks',result:'complete',rows:80}]}};
assert(h.post(snapshotEvent).ok);
assert(h.post({...snapshotEvent,type:'detail',reason:'r_other',detail:'new feedback',feedback_seq:1,
  stats:{...snapshotEvent.stats,snapshot_at:'2026-09-29T11:00:00Z',diag_revision:7,s_colorful:0,
    exp_started:7,diag_totals:{attempts:7},diag_attempts:[{mode:'posts',result:'stopped',rows:7}],page_s:12}}).ok);
const ordered=rowOf('Sheet1','snapshot-order');
assert.equal(ordered.diag_revision,8);
assert.equal(ordered.s_colorful,1,'stale URL preferences must not replace the newer snapshot');
assert.equal(ordered.exp_started,8);
assert.equal(ordered.d_attempts,8);
assert.equal(ordered.last_attempt_mode,'bookmarks');
assert.equal(ordered.snapshot_at,'2026-09-29T12:00:00Z');
assert.equal(ordered.detail,'new feedback','feedback revisions remain independent of URL snapshot freshness');
assert.equal(ordered.page_s,12);
// Settings can change without incrementing diagnostics; snapshot time orders them.
assert(h.post({...snapshotEvent,stats:{...snapshotEvent.stats,snapshot_at:'2026-09-29T13:00:00Z',s_colorful:0}}).ok);
assert.equal(rowOf('Sheet1','snapshot-order').s_colorful,0);
assert(h.post({...snapshotEvent,stats:{...snapshotEvent.stats,snapshot_at:'2026-09-29T12:30:00Z',s_colorful:1}}).ok);
assert.equal(rowOf('Sheet1','snapshot-order').s_colorful,0);
const digitsId='123456789012345678901';
assert(h.post({sessionId:digitsId,source:'direct',type:'open'}).ok);
assert(h.post({sessionId:digitsId,source:'direct',stats:{page_s:2}}).ok);
assert.equal(h.sheets.Sheet1.rows.filter(line=>line[1]===digitsId).length,1,'numeric-looking session IDs stay text and upsert');

// Routing and validation.
assert(h.post({...event,sessionId:'self-check',test:true}).ok);
assert.equal(h.sheets.TelemetryTests.getLastRow(),2);
assert(h.post({...event,sessionId:'formula-test',test:true,stats:{schema_version:2,diag_attempts:[{mode:'=1+1'}]}}).ok);
assert.equal(rowOf('TelemetryTests','formula-test').last_attempt_mode,'=1+1');
const rowsBefore=h.sheets.Sheet1.getLastRow();
for (const bad of [
  {...event,sessionId:'usage:install:day',source:'usage',stats:{schema_version:2,consent_version:1,install_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}},
  {...event,sessionId:'bad-source',source:'other'},
  {...event,sessionId:'bad-type',type:'heartbeat'},
  {...event,sessionId:'bad-schema',stats:{schema_version:3}},
  {...event,sessionId:'bad-test',test:'yes'},
  {...event,sessionId:'bad id with spaces'},
  [event]
]) assert.deepEqual(h.post(bad),{ok:false,error:'invalid'});
assert.deepEqual(h.post('{not json'),{ok:false,error:'invalid'});
assert.deepEqual(h.post('x'.repeat(64001)),{ok:false,error:'too_large'});
assert.equal(h.sheets.Sheet1.getLastRow(),rowsBefore,'rejected requests write nothing');
assert(!h.sheets.Usage,'no usage sheet is created');
assert(h.logged.length>0,'rejections are logged server-side');
assert(!JSON.stringify(h.post({...event,source:'x'})).includes('Error'),'clients receive generic codes only');

// Unknown keys are dropped and every string is capped.
assert(h.post({sessionId:'caps',source:'direct',type:'detail',reason:'r_other',detail:'d'.repeat(9000),feedback_seq:1,
  pageLang:'p'.repeat(500),ts:'t'.repeat(500),injected:'=1',stats:{schema_version:'2',last_err:'e'.repeat(500),unknown_key:'x',
  subreason_labels_all:'l'.repeat(9000)}}).ok);
const capped=rowOf('Sheet1','caps');
assert.equal(capped.detail.length,4000);
assert.equal(capped.pageLang.length,16);
assert.equal(capped.clientTs.length,32);
assert.equal(capped.last_err.length,128);
assert.equal(capped.subreason_labels_all.length,4000);
assert(!h.sheets.Sheet1.rows[0].includes('injected') && !h.sheets.Sheet1.rows[0].includes('unknown_key'));

// Abuse limits: per-session budget, then a global new-session cap, both
// refused before the ScriptLock is requested.
const limits=harness();
for (let i=0;i<40;i++) assert(limits.post({sessionId:'flood',source:'direct',stats:{page_s:i}}).ok);
const locksBefore=limits.lockCalls.length;
assert.deepEqual(limits.post({sessionId:'flood',source:'direct'}),{ok:false,error:'rate_limited'});
for (let i=1;i<300;i++) assert(limits.post({sessionId:'new-'+i,source:'direct',type:'open'}).ok);
assert.deepEqual(limits.post({sessionId:'one-too-many',source:'direct',type:'open'}),{ok:false,error:'busy'});
assert(limits.post({sessionId:'new-1',source:'direct',stats:{page_s:9}}).ok,'known sessions can still update');
assert.equal(limits.lockCalls.length,locksBefore+300,'limited requests never touch the lock');
assert(limits.lockCalls.every(ms=>ms<=5000),'ScriptLock wait is at most 5 s');
const locked=harness({lockAvailable:false});
assert.deepEqual(locked.post(event),{ok:false,error:'busy'});
assert.deepEqual(locked.sheets.Sheet1.rows,oldRows);

// Web apps have no active spreadsheet. Resolve the private property with openById.
assert(harness({expectedId:BOUND_ID}).post(event).ok);
const unconfigured=harness({expectedId:null});
assert.deepEqual(unconfigured.post(event),{ok:false,error:'unavailable'});
assert.deepEqual(unconfigured.sheets.Sheet1.rows,oldRows,'missing config must not select any workbook');
assert.throws(()=>unconfigured.ctx.configureBoundSpreadsheet(),/bound spreadsheet/);
const editor=harness({expectedId:null,activeSpreadsheet:true});
assert.equal(editor.ctx.configureBoundSpreadsheet().ok,true);
assert(editor.post(event).ok,'editor initialization stores the workbook ID privately');
const wrongEditor=harness({expectedId:'another-workbook',activeSpreadsheet:true});
assert.throws(()=>wrongEditor.ctx.configureBoundSpreadsheet(),/mismatch/,'setup cannot silently retarget an existing collector');
const wrong=harness({expectedId:'another-workbook'});
assert.deepEqual(wrong.post(event),{ok:false,error:'unavailable'});
assert.deepEqual(wrong.sheets.Sheet1.rows,oldRows,'wrong workbook fails closed');
assert.equal(wrong.ctx.doGet().ok,false);
assert.equal(wrong.ctx.findReceipt('test-new','receipt-verified-123').ok,false);
console.log('Collector migration, routing, ordering, formula safety, validation, abuse limits and workbook binding passed.');
