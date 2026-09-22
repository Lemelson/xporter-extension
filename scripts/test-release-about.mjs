import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';
toolingPolicy.assertBrowserSmokeCanLaunch();
const {chromium}=await import('playwright');
const root=process.cwd();
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const expectedPoints=JSON.parse(fs.readFileSync(path.join(root,'popup/locales/en.json'),'utf8')).update200Body.split('\n').length;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'xporter-release-'));
const context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
try {
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const page=await context.newPage();await page.setViewportSize({width:350,height:600});
 for(const language of ['ru','en','ar']) {
  await worker.evaluate(language=>XPorterStorage.saveSettings({language}),language);
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await page.locator('#tabBtnAbout').click();
  const note=page.locator('.update-item').first();await note.locator('.detail-head').click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#extensionVersion').textContent(),`v${manifest.version}`);
  assert.equal(await note.locator('.update-meta-version').textContent(),`v${manifest.version}`);
  assert.equal((await note.locator('p').textContent()).split('\n').length,expectedPoints);
  const geometry=await note.locator('.detail-body').evaluate(el=>({height:el.getBoundingClientRect().height,content:el.scrollHeight}));
  assert(geometry.height>=geometry.content-2,JSON.stringify({language,geometry}));
  await note.locator('.update-meta').scrollIntoViewIfNeeded();
  assert(await note.locator('.update-meta').isVisible());
 }
 console.log(`${manifest.version} About: footer, ${expectedPoints} release-note points and unclipped expanded content verified in RU/EN/AR.`);
} finally {await context.close();fs.rmSync(profile,{recursive:true,force:true});}
