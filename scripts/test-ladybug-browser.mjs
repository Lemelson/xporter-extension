import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';
toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-ladybug-'));
const context = await chromium.launchPersistentContext(profile, {
  channel:'chromium',headless:true,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]
});
try {
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page=await context.newPage();
  await page.setViewportSize({width:350,height:600});
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  assert.equal(await page.locator('#ladybugSquashCount').count(), 1);
  assert.equal(await page.locator('#ladybugSquashCount').textContent(), '(0)');
  await page.locator('[data-tab="about"]').click();
  const bug=page.locator('.ladybug');
  await bug.scrollIntoViewIfNeeded();
  await bug.click({force:true});
  await page.waitForFunction(async()=>((await chrome.storage.local.get('xporter_usage')).xporter_usage?.ladybugSquashes)===1);
  await page.waitForTimeout(1250);
  assert.equal(await bug.isVisible(),false);
  await page.waitForTimeout(1400);
  assert.equal(await bug.isVisible(),true);
  await page.waitForTimeout(11000);
  await bug.click({force:true});
  await page.waitForFunction(async()=>((await chrome.storage.local.get('xporter_usage')).xporter_usage?.ladybugSquashes)===2);
  assert.equal(await page.locator('#ladybugSquashCount').textContent(), '(2)');
  const stats=await worker.evaluate(()=>XPorterFeedback.snapshot());
  assert.equal(stats.ladybug_squashes,2);
  await page.reload();
  assert.equal(await page.evaluate(async()=> (await chrome.storage.local.get('xporter_usage')).xporter_usage.ladybugSquashes),2);
  await page.waitForFunction(()=>document.getElementById('ladybugSquashCount').textContent==='(2)');
  console.log('Unpacked Chromium: two squashes, automatic respawn, persistence after reload and uninstall snapshot verified.');
} finally {await context.close();fs.rmSync(profile,{recursive:true,force:true});}
