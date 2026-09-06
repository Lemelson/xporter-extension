import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';
toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import('playwright');
const root = process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-motion-'));
const context = await chromium.launchPersistentContext(profile, {headless:true,executablePath:chromium.executablePath(),args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
try {
 const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 const avatar='https://pbs.twimg.com/profile_images/1405314351486144519/Uage5phF_400x400.jpg';
 await context.route('https://pbs.twimg.com/**', r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="skyblue"/></svg>'}));
 const state={running:true,status:'fetching',username:'ericweinstein',exportMode:'posts',tweetCount:96,settings:{quantityLimit:0},userInfo:{name:'Eric Weinstein',screenName:'ericweinstein',profileImageUrl:avatar}};
 await worker.evaluate(async state=>{
  currentExport=state;
  await XPorterStorage.saveExportState({...state,status:'stopped',running:false,tweetCount:567,totalBatches:1});
  await XPorterStorage.saveTweetBatch(0,Array.from({length:567},(_,i)=>({id:String(2000000000000000000n+BigInt(i)),text:'Local preview post',created_at:'2025-01-01T00:00:00.000Z',type:'tweet'})));
 },state);
 const page=await context.newPage();
 await page.setViewportSize({width:400,height:600});
 await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
 await page.waitForFunction(()=>document.getElementById('tweetCount').textContent.includes('96'));
 await page.waitForTimeout(300);
 assert.equal(await page.locator('#targetAccountAvatar').isVisible(),true,'export already resolved the profile: avatar must survive unavailable active-tab context');
 assert.equal(await page.locator('#targetAccountName').textContent(),'Eric Weinstein');
 const box=await page.locator('#targetAccountCard .account-avatar').boundingBox();
 assert(Math.abs(box.width-box.height)<1,`avatar must be circular: ${JSON.stringify(box)}`);
 const stop=await page.locator('#stopBtn').boundingBox();
 const actions=await page.locator('#statusActionStack').boundingBox();
 assert(Math.abs(stop.width-actions.width)<2,'Stop must fill its row');
 console.log('PASS resolved profile fallback, circular avatar and full-width Stop');
 const showStatus = async patch => worker.evaluate(async patch=>{
   Object.assign(currentExport, patch);
   await chrome.runtime.sendMessage({type:'EXPORT_STATUS_UPDATE',...await getExportStatus()});
 },patch);
 const counter=page.locator('#tweetCount');
 await showStatus({tweetCount:128});
 assert.match(await counter.getAttribute('aria-label'),/^128 /);
 assert(await counter.evaluate(el=>el.getAnimations({subtree:true}).length)>0,'new digits must roll');
 const animations=await counter.evaluate(el=>el.getAnimations({subtree:true}).map(a=>a.effect.getKeyframes()));
 assert(animations.every(frames=>frames[0].transform==='translateY(100%)'),'digits enter vertically');
 for(const tweetCount of [137,999,1000,1001]) await showStatus({tweetCount});
 await page.waitForTimeout(650);
 assert.match(await counter.getAttribute('aria-label'),/^1,001 /);
 assert.equal(await counter.evaluate(el=>el.getAnimations({subtree:true}).length),0,'digit animation must settle');
 await showStatus({tweetCount:1001});
 assert.equal(await counter.evaluate(el=>el.getAnimations({subtree:true}).length),0,'identical polling must not replay motion');
 await page.emulateMedia({reducedMotion:'reduce'});
 await showStatus({tweetCount:1200});
 assert.equal(await counter.evaluate(el=>el.getAnimations({subtree:true}).length),0);
 assert.equal(await page.locator('#progressFill').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 // Neither a profile total nor calendar coverage proves a collected share.
 await showStatus({running:false,status:'stopped',tweetCount:567,userInfo:{...state.userInfo,tweetCount:24900}});
 assert.equal(await page.locator('.progress-bar').isVisible(),false,'unknown stopped exports have no fabricated fraction');
 assert.equal(await counter.evaluate(el=>el.getAnimations({subtree:true}).length),0);
 const progress=await worker.evaluate(()=>{
   currentExport.dateFrom=new Date('2024-01-01');currentExport.dateTo=new Date('2025-01-01');
   currentExport.oldestTweetDate=new Date('2024-01-02');
   currentExport.settings.quantityLimit=0;
   const unknown=computeSearchCaptureProgress();
   currentExport.settings.quantityLimit=1000;currentExport.tweetCount=100;
   return {unknown,limited:computeSearchCaptureProgress()};
 });
 assert.deepEqual(progress,{unknown:null,limited:10});
 console.log('PASS digit roll, rapid updates, reduced motion, static stopped state and truthful limit-only progress');
 const capturePreview = () => page.evaluate(() => document.querySelector('.header').outerHTML + document.querySelector('.tabs').outerHTML + '<section class="tab-content active">' + document.getElementById('exportStatus').outerHTML + document.querySelector('.export-format-row').outerHTML + document.getElementById('usernameField').outerHTML + '</section>');
 const output=process.env.XPORTER_MOTION_OUTPUT || '/private/tmp/xporter-motion-qa';fs.mkdirSync(output,{recursive:true});
 for(const language of ['ar','de','en','ru']) for(const theme of ['dark','light']) for(const simplifiedDesign of [false,true]) {
  for(const uiScale of [85,100,115,130]) {
   await worker.evaluate(async settings=>{await chrome.storage.local.set({xporter_settings:settings});currentExport=null;}, {language,theme,simplifiedDesign,uiScale});
   const width=Math.round(400*uiScale/100);
   await page.setViewportSize({width,height:600});await page.reload();
   await page.waitForFunction(lang=>document.documentElement.lang===lang,language);
   await worker.evaluate(state=>{currentExport=state},state);
   await showStatus({tweetCount:96});await showStatus({tweetCount:128});
   await page.waitForTimeout(550);
   const geometry=await page.locator('#targetAccountCard .account-avatar').boundingBox();
   assert(Math.abs(geometry.width-geometry.height)<1,`${language}/${theme}/${simplifiedDesign}/${uiScale}: circular`);
   assert.equal(await page.locator('#targetAccountAvatar').isVisible(),true);
   const row=await page.locator('#statusActionStack').boundingBox(),button=await page.locator('#stopBtn').boundingBox();
   assert(Math.abs(row.width-button.width)<1);
   for(const viewportWidth of [width,320]) {
    await page.setViewportSize({width:viewportWidth,height:600});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${language}/${theme}/${uiScale}: no overflow`);
   }
   await page.setViewportSize({width,height:600});
   if(uiScale===100 && language==='en') {
    await page.locator('#authWarning').evaluate(el=>el.classList.add('hidden'));
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(output,`running-${theme}-${simplifiedDesign?'simple':'blue'}.png`)});
    if(theme==='dark' && !simplifiedDesign) fs.writeFileSync(path.join(output,'running.html'),await capturePreview());
   }
   await showStatus({running:false,status:'stopped',tweetCount:567});
   await page.waitForFunction(()=>document.querySelector('#downloadBtn').textContent.includes(formatNumber(567,document.documentElement.lang)));
   for(const id of ['downloadBtn','resumeBtn','newExportBtn']) {
    const css=await page.locator('#'+id).evaluate(el=>{const s=getComputedStyle(el);return {border:s.borderTopWidth,color:s.borderTopColor,height:el.getBoundingClientRect().height}});
    assert(parseFloat(css.border)>0 && css.color!=='rgba(0, 0, 0, 0)',`${id}: permanent outline`);
   }
   if(uiScale===100 && language==='en') {
    await page.screenshot({path:path.join(output,`stopped-${theme}-${simplifiedDesign?'simple':'blue'}.png`)});
    if(theme==='dark' && !simplifiedDesign) fs.writeFileSync(path.join(output,'stopped.html'),await capturePreview());
   }
  }
 }
 console.log('PASS 64 appearance combinations: avatar geometry, motion, controls and narrow viewport');

} finally {await context.close();fs.rmSync(profile,{recursive:true,force:true});}
