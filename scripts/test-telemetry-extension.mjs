// Disposable unpacked Chrome verification. Synthetic local data; upload fetch is
// intercepted inside the worker, so consent checks never write production rows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';
toolingPolicy.assertBrowserSmokeCanLaunch();
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=process.cwd(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'xporter-telemetry-extension-'));
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(),acceptDownloads:true,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
try {
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 await worker.evaluate(()=>{
  const original=fetch;globalThis.testUploads=[];
  globalThis.fetch=async (url,options)=>{
   if(String(url).includes('script.google')){const body=JSON.parse(options.body);testUploads.push(body);return new Response(JSON.stringify({ok:true,collector_version:2,sessionId:body.sessionId,sheet:'Usage'}));}
   return original(url,options);
  };
 });
 const page=await context.newPage(),errors=[];await page.setViewportSize({width:350,height:600});page.on('pageerror',e=>errors.push(e.message));
 const url=`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;
 await page.goto(url);await page.locator('#tabBtnSettings').click();
 assert.equal(await page.locator('#diagnosticsSettings, #diagnosticsSharing, #downloadDiagnostics').count(),0);
 // Even consent stored by an old version must have no effect.
 await worker.evaluate(()=>XPorterStorage.saveSettings({diagnosticsSharing:true,diagnosticsConsentVersion:1}));
 for(const type of ['SET_DIAGNOSTICS_SHARING','GET_DIAGNOSTIC_REPORT']) {
  const result=await page.evaluate(type=>chrome.runtime.sendMessage({type,enabled:true}),type);
  assert.equal(result.error,'Unknown message type');
 }
 await page.evaluate(()=>chrome.runtime.sendMessage({type:'DIAGNOSTIC_START_REJECTED',mode:'posts',format:'csv',error:'INVALID_USERNAME'}));
 const report={report:await worker.evaluate(()=>XPorterFeedback.snapshot())};
 assert.equal(report.report.diag_attempts.at(-1).error,'INVALID_USERNAME');
 assert.equal(await worker.evaluate(()=>testUploads.length),0);
 assert.equal(await worker.evaluate(()=>typeof XPorterUsageUpload),'undefined');
 // Real downloads API + real diagnostics module, using one synthetic local seen post.
 const saved=await worker.evaluate(async()=>{
  const original=XPorterPostDB.getAllPosts;XPorterPostDB.getAllPosts=async()=>[{id:'1',text:'synthetic local verification',author_username:'synthetic'}];
  try{return await XPorterDownloads.downloadSeenPosts('json');}finally{XPorterPostDB.getAllPosts=original;}
 });
 assert(saved.success,JSON.stringify(saved));
 for(let i=0;i<50;i++){if(await worker.evaluate(async()=> (await XPorterFeedback.snapshot()).diag_downloads.some(d=>d.source==='seen_posts'&&d.result==='complete')))break;await page.waitForTimeout(100);}
 const after={report:await worker.evaluate(()=>XPorterFeedback.snapshot())};
 const savedEntry=after.report.diag_downloads.at(-1);assert.equal(savedEntry.rows,1);assert(savedEntry.bytes>0);
 assert(!JSON.stringify(after.report).includes('synthetic local verification'));assert(!JSON.stringify(after.report).includes('author_username'));
 const uninstallProof=await worker.evaluate(async()=>{
  await XPorterStorage.saveSettings({language:'zh',themePreset:'obsidian',theme:'dark',simplifiedDesign:true,ladybugEnabled:false,popupWidth:125,popupHeight:75,uiScale:110,textScale:120,autoExpireEnabled:false,autoExpireHours:8,exportMode:'bookmarks',outputFormat:'txt'});
  const original=chrome.runtime.setUninstallURL;let captured='';
  chrome.runtime.setUninstallURL=async url=>{captured=url;return original(url);};
  try {await XPorterFeedback.refresh();return {length:captured.length,stats:await XPorterDiagnosticsCodec.decode(new URL(captured).searchParams.get('d2'))};}
  finally {chrome.runtime.setUninstallURL=original;}
 });
 assert(uninstallProof.length<=1023);assert.equal(uninstallProof.stats.ui_lang,'zh');
 for(const [key,value] of Object.entries({theme_preset:'obsidian',s_colorful:1,s_ladybug:0,s_window_width:125,s_window_height:75,s_element_size:110,s_text_size:120,s_auto_expire:0,s_auto_expire_hours:8,s_mode:'bookmarks',s_format:'txt'})) assert.equal(uninstallProof.stats[key],value);assert.equal(uninstallProof.stats.diag_downloads.at(-1).result,'complete');
 for(const language of ['en','ru','zh','ar']){
  await worker.evaluate(language=>XPorterStorage.saveSettings({language}),language);await page.reload();await page.locator('#tabBtnSettings').click();
  assert.equal(await page.locator('#diagnosticsSettings, #downloadDiagnostics').count(),0);
  await page.screenshot({path:path.join(os.tmpdir(),`xporter-diagnostics-settings-${language}.png`)});
 }
 assert.equal(await worker.evaluate(()=>testUploads.length),0);
 assert.deepEqual(errors,[]);console.log('PASS unpacked extension: sharing removed even with old consent, rejected legacy routes, real browser download completion, 4 locale settings. No production uploads.');
}finally{await context.close();fs.rmSync(profile,{recursive:true,force:true});}
