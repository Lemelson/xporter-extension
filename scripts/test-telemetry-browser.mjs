// Exercise real page decoding, all languages, reason/subreason events and
// acknowledgement against the real collector code with an in-memory sheet.
// All network is intercepted: no production analytics can be written here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import toolingPolicy from './tooling-policy.js';
toolingPolicy.assertBrowserSmokeCanLaunch();
const require=createRequire(import.meta.url);
const {harness}=require('./feedback-collector-harness.cjs');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const collector=harness();
const codecContext=vm.createContext({TextEncoder,TextDecoder,CompressionStream,DecompressionStream,Blob,Response,btoa,atob});
vm.runInContext(fs.readFileSync('utils/diagnostics-codec.js','utf8'),codecContext);
const codec=codecContext.XPorterDiagnosticsCodec;
const browser=await chromium.launch({headless:true,executablePath:process.env.XPORTER_BROWSER_EXECUTABLE});
const failures=[],packets=[];
let receiptResponse = null;
const langs=['en','ru','de','fr','es','it','pt','tr','ar','hi','ja','ko','zh','id'];
try {
  const context=await browser.newContext({locale:'en-US',reducedMotion:'reduce'});
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.hostname==='localhost') {
      if(request.isNavigationRequest()) return route.fulfill({contentType:'text/html',body:fs.readFileSync('docs/feedback.html','utf8')});
      const asset=url.pathname.slice(1);
      if(['assets/emoji-platform.js','assets/diagnostics-codec.js','assets/feedback-language.js','assets/feedback-receipt.js','vendor/canvas-confetti.browser.js'].includes(asset))
        return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join('docs',asset),'utf8')});
      return route.abort();
    }
    if(url.hostname==='script.google.com') {
      if(request.method()==='POST') {
        const payload=JSON.parse(request.postData());packets.push(payload);
        const result=collector.post(payload);assert(result.ok,JSON.stringify(result));
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
      }
      if(url.searchParams.has('callback')) {
        const result=receiptResponse ? await receiptResponse()
          : collector.ctx.findReceipt(url.searchParams.get('sessionId'),url.searchParams.get('receipt_id'));
        return route.fulfill({contentType:'application/javascript',body:url.searchParams.get('callback')+'('+JSON.stringify(result)+');'});
      }
    }
    return route.abort();
  });
  await context.exposeBinding('recordCspViolation',(_,violation)=>failures.push('CSP: '+violation));
  await context.addInitScript(()=>document.addEventListener('securitypolicyviolation',event=>{
    window.recordCspViolation(event.violatedDirective+' '+event.blockedURI);
  }));
  const page=await context.newPage();page.on('pageerror',error=>failures.push(error.message));
  // A slow receipt must never become success solely because 1.2 seconds passed.
  for (const accepted of [false,true]) {
    const receiptStarted=Promise.withResolvers(),receiptGate=Promise.withResolvers();
    receiptResponse=()=>{receiptStarted.resolve();return receiptGate.promise;};
    await page.goto('http://localhost/feedback.html?live=1&receipt-case='+accepted);
    await page.locator('[data-reason="r_other"]').click();
    await page.locator('#detail').fill('Synthetic delayed receipt');
    await page.locator('#submitBtn').click();
    await receiptStarted.promise;
    await page.waitForTimeout(1400);
    assert.equal(await page.locator('#thanks.show').count(),0,'success waits for persistence receipt');
    assert.equal(await page.locator('#submitBtn').isDisabled(),true,'Send stays pending during receipt check');
    receiptGate.resolve({ok:accepted});
    if (accepted) await page.locator('#thanks.show').waitFor();
    else {
      await page.waitForFunction(()=>!document.querySelector('#submitBtn').disabled);
      assert.equal(await page.locator('#thanks.show').count(),0,'failed receipt keeps feedback editable');
      assert.equal(await page.locator('#detail').inputValue(),'Synthetic delayed receipt');
    }
  }
  receiptResponse=null;
  console.log('PASS delayed success and failure receipts: no optimistic acknowledgement');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('#backToFeedback').click();
  await page.locator('#detail').fill('');
  await page.locator('#submitBtn').click();
  await page.locator('#thanks.show').waitFor();
  const cleared=packets.filter(item=>item.type==='detail').at(-1);
  const sheetRows=collector.sheets.Sheet1.rows;
  const clearedRow=sheetRows.find(row=>row[sheetRows[0].indexOf('sessionId')]===cleared.sessionId);
  assert.equal(clearedRow[sheetRows[0].indexOf('detail')],'','Back and empty Send clears the saved comment');
  await page.emulateMedia({reducedMotion:'reduce'});
  console.log('PASS clear-and-resubmit with normal-motion success screen');
  for(const lang of langs) {
    const stats={schema_version:2,v:'1.6.5',ui_lang:lang,install_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      s_colorful:1,s_ladybug:0,s_window_width:125,s_window_height:75,s_element_size:110,s_text_size:120,
      s_auto_expire:0,s_auto_expire_hours:8,s_mode:'bookmarks',s_format:'txt',s_safety:'3_20',diag_attempts:[{id:1,mode:'bookmarks',format:'xlsx',result:'stopped',rows:25,firstItemMs:null,settings:{includeReplies:true}}]};
    const url=await codec.buildURL('http://localhost/feedback.html',stats);
    await page.goto(url+'&live=1');
    await page.locator('.reason').first().waitFor();
    const expected=lang==='zh'?'zh-CN':lang==='pt'?'pt-BR':lang;
    assert.equal(await page.locator('html').getAttribute('lang'),expected);
    assert.equal(await page.locator('html').getAttribute('dir'),lang==='ar'?'rtl':'ltr');
    assert.equal(await page.locator('.reason').count(),8);
    for(const reason of ['r_broken','r_confusing','r_slow','r_missing','r_once','r_alt','r_privacy','r_other']) {
      await page.locator(`[data-reason="${reason}"]`).click();
      const chips=page.locator('[data-subreason]');assert((await chips.count())>=3);
      const first=chips.first();await first.click();
      assert.equal(await first.getAttribute('aria-pressed'),'true');
      await first.click();assert.equal(await first.getAttribute('aria-pressed'),'false');
      await first.click();
    }
    await page.locator('#detail').fill('Synthetic locale check '+lang);
    await page.locator('#submitBtn').click();
    await page.locator('#thanks.show').waitFor();
    const submitted=packets.filter(item=>item.type==='detail').at(-1);
    assert.equal(submitted.pageLang,expected.replace('-','_'));
    assert.equal(submitted.stats.ui_lang,lang);
    assert.equal(submitted.stats.language_source,'extension');
    assert.equal(submitted.stats.diag_attempts[0].mode,'bookmarks');
    assert.equal(submitted.stats.diag_attempts[0].rows,25);
    assert.equal(submitted.stats.diag_attempts[0].firstItemMs,null);
    assert.equal(submitted.stats.s_safety,'3_20');
    const rows=collector.sheets.Sheet1.rows;
    const saved=rows.find(row=>row[rows[0].indexOf('sessionId')]===submitted.sessionId);
    for(const key of ['s_colorful','s_ladybug','s_window_width','s_window_height','s_element_size','s_text_size','s_auto_expire','s_auto_expire_hours','s_mode','s_format']) {
      assert.equal(submitted.stats[key],stats[key]);
      assert.equal(saved[rows[0].indexOf(key)],stats[key]);
    }
    assert.equal(submitted.reason,'r_other');
    assert(submitted.stats.subreasons.includes('sr_other_'));
    assert.equal(collector.ctx.findReceipt(submitted.sessionId,submitted.receipt_id).ok,true);
    const before=collector.sheets.Sheet1.getLastRow();
    await page.reload();await page.locator('.reason').first().waitFor();
    assert.equal(collector.sheets.Sheet1.getLastRow(),before,'reload keeps same visit');
    console.log('PASS locale, selections, compressed payload, receipt, reload: '+lang);
  }
  await page.goto('http://localhost/feedback.html?preview=1&ui_lang=ZH_cn');await page.locator('.reason').first().waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
  await page.goto('http://localhost/feedback.html?preview=1&d2=INVALID');await page.locator('.reason').first().waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  await page.screenshot({path:'/private/tmp/xporter-telemetry-feedback.png'});
  assert.deepEqual(failures,[]);
  console.log('All 14-language telemetry browser flows passed; no live requests.');
} finally {await browser.close();}
