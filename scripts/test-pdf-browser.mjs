#!/usr/bin/env node
// Disposable Helium, generated fixtures only. No authenticated X requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import toolingPolicy from './tooling-policy.js';
toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(import.meta.dirname,'..');
const out=process.env.XPORTER_PDF_QA_OUT || path.resolve(root,'../outputs/xporter-insights-20260930');
fs.mkdirSync(out,{recursive:true});
const context=vm.createContext({URL});
for (const file of ['utils/columns-i18n.js','utils/pdf.js']) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
const copy=JSON.parse(fs.readFileSync(path.join(root,'popup/locales/en.json'),'utf8'));
const text='Hello world. Привет мир. 中文文本：山与湖。 مرحبا بالعالم، الجبل والبحيرة.';
const row={
 id:'1234567890123456789',type:'reply',author_name:'Ada · Ада',author_username:'ada',text,
 tweet_url:'https://x.com/ada/status/1234567890123456789',created_at:'2026-09-30T12:00:00Z',favorite_count:123,view_count:1000,
 media_type:'photo',media_urls:'https://pbs.twimg.com/media/example.jpg',media_alt_texts:'ALT: A mountain reflected in a lake. Гора отражается в озере. 山倒映在湖中。 جبل ينعكس في البحيرة.',
 reply_to_post:{text:'Parent reply context. Контекст ответа. 回复上下文。 سياق الرد.',author_name:'Grace',author_username:'grace',media_alt_texts:'Parent ALT',quoted_post:{text:'Nested quotation.',media_alt_texts:'Nested ALT'}},
 quoted_post:{text:'Quote context with a safe link.',tweet_url:'https://example.org/?a=1&b=2',media_alt_texts:'Quoted ALT'}
};
const article={id:'9876543210123456789',type:'article',author_name:'长文 · Автор',author_username:'writer',text:'Article with all source-provided text.',article_title:'Long article · Длинная статья · 长文 · مقالة طويلة',article_text:Array.from({length:16},(_,i)=>`${i+1}. ${text}\nThe export keeps the text X returned, including Unicode and paragraph boundaries. This paragraph verifies multipage wrapping, with a long URL https://example.com/${'segment/'.repeat(20)}end.`).join('\n\n')};
const html=context.XPorterPDF.generate([row,article],{}, {mode:'bookmarks',lang:'en',translations:copy,exportedAt:'2026-09-30T12:00:00Z',exportStatus:'partial'});
const htmlPath=path.join(out,'pdf-sample.html');fs.writeFileSync(htmlPath,html);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'xporter-pdf-qa-'));
const browser=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(),viewport:{width:1000,height:900},args:['--no-first-run']});
try {
 const page=await browser.newPage();const requests=[],errors=[];
 page.on('request',r=>{if(!r.url().startsWith('file:'))requests.push(r.url());});
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.__printCalls=0;window.print=()=>window.__printCalls++;});
 await page.goto('file://'+htmlPath);
 assert.equal(await page.evaluate(()=>window.__printCalls),0,'no print dialog before click');
 await page.getByRole('button',{name:'Print / Save as PDF',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.__printCalls),1,'CSP allows the explicit print button');
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[],'the document stays offline');
 assert.equal(await page.locator('article').count(),2);
 const overflow=await page.evaluate(()=>Array.from(document.querySelectorAll('.post-text,.article-text,.field dd')).filter(n=>n.scrollWidth>n.clientWidth+1).length);
 assert.equal(overflow,0);
 await page.screenshot({path:path.join(out,'pdf-sample-browser.png'),fullPage:true});
 await page.pdf({path:path.join(out,'pdf-sample.pdf'),printBackground:true,preferCSSPageSize:true});
 console.log(JSON.stringify({html:htmlPath,pdf:path.join(out,'pdf-sample.pdf'),printButtonCalls:1,externalRequests:requests.length,overflow,errors}));
} finally {await browser.close();fs.rmSync(profile,{recursive:true,force:true});}
