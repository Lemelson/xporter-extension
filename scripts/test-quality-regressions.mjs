#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';

try {
  toolingPolicy.assertBrowserSmokeCanLaunch();
} catch (error) {
  console.error(`${error.code || 'BROWSER_SMOKE_BLOCKED'}: ${error.message}`);
  process.exit(1);
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.XPORTER_TEST_EXTENSION_ROOT || process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-settings-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(),
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.setViewportSize({ width: 350, height: 600 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  // The empty database disables Clear only after the final popup module mounts.
  const waitForPopup = () => page.waitForFunction(
    () => document.getElementById('clearFeedDb')?.disabled === true,
    null, { timeout: 10000 }
  );
  await waitForPopup();
  const defaults = await page.evaluate(async () =>
    (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).settings);

  async function reset(patch = {}) {
    await page.evaluate(async settings => {
      await chrome.storage.local.set({ xporter_settings: settings });
      await chrome.storage.local.remove('xporter_photo_permission_intro_seen');
    }, { ...defaults, language: 'en', ...patch });
    await page.reload();
    await waitForPopup();
    await page.locator('[data-tab="settings"]').click();
  }
  const saved = () => page.evaluate(async () =>
    (await chrome.storage.local.get('xporter_settings')).xporter_settings);
  async function change(id, value) {
    await page.locator(`#${id}`).evaluate((control, value) => {
      control.value = String(value);
      control.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
  const failures = [];
  async function check(name, run) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(error); console.error(`FAIL ${name}: ${error.message}`); }
  }

  await check('saved legacy quantity stays finite after unrelated edit', async () => {
    await reset({ quantityLimit: 5000 });
    assert.equal(await page.locator('#quantityLimit').inputValue(), 'custom');
    assert.equal(await page.locator('#customQuantity').inputValue(), '5000');
    await change('autoExpireHours', 8);
    await page.waitForTimeout(700);
    assert.equal((await saved()).quantityLimit, 5000);
  });

  await check('pending autosave cannot accept an unconfirmed retry increase', async () => {
    await reset({ includeAboutAccountDetails: true, aboutAccountMaxRetries: 15 });
    await page.evaluate(() => {
      for (const [id, value] of [['quantityLimit', '100'], ['aboutAccountMaxRetries', '120']]) {
        const control = document.getElementById(id);
        control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.locator('#aboutRiskDialog').waitFor({ state: 'visible' });
    await page.waitForTimeout(700);
    assert.equal((await saved()).aboutAccountMaxRetries, 15);
    await page.locator('#aboutRiskCancel').click();
    assert.equal(await page.locator('#aboutAccountMaxRetries').inputValue(), '15');
  });

  await check('typing retries cannot enter autosave before blur and confirmation', async () => {
    await reset({ includeAboutAccountDetails: true, aboutAccountMaxRetries: 15 });
    await page.locator('#aboutAccountMaxRetries').focus();
    await change('quantityLimit', 100);
    await page.locator('#aboutAccountMaxRetries').fill('120');
    await page.waitForTimeout(700);
    assert.equal((await saved()).quantityLimit, 100, 'the unrelated autosave must actually run');
    assert.equal((await saved()).aboutAccountMaxRetries, 15);
    await page.locator('#aboutAccountMaxRetries').press('Tab');
    await page.locator('#aboutRiskDialog').waitFor({ state: 'visible' });
    await page.locator('#aboutRiskCancel').click();
    assert.equal(await page.locator('#aboutAccountMaxRetries').inputValue(), '15');

    await page.locator('#aboutAccountMaxRetries').fill('120');
    await page.locator('#aboutAccountMaxRetries').press('Tab');
    await page.locator('#aboutRiskConfirm').click({ timeout: 10000 });
    await page.waitForFunction(async () =>
      (await chrome.storage.local.get('xporter_settings')).xporter_settings.aboutAccountMaxRetries === 120);
    await page.locator('#aboutAccountMaxRetries').fill('30');
    await page.locator('#aboutAccountMaxRetries').press('Tab');
    await page.waitForFunction(async () =>
      (await chrome.storage.local.get('xporter_settings')).xporter_settings.aboutAccountMaxRetries === 30);
    assert.equal(await page.locator('#aboutRiskDialog').isVisible(), false);
  });

  await check('pending autosave cannot enable unconfirmed photo embedding', async () => {
    await reset({ outputFormat: 'xlsx', embedPostPhotos: false });
    await page.locator('[data-tab="home"]').click();
    await page.evaluate(() => {
      const quantity = document.getElementById('quantityLimit');
      quantity.value = '100';
      quantity.dispatchEvent(new Event('change', { bubbles: true }));
      const photo = document.getElementById('xlsxPhotoEmbed');
      photo.checked = true;
      photo.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#photoPermissionDialog').waitFor({ state: 'visible' });
    await page.waitForTimeout(700);
    assert.equal((await saved()).embedPostPhotos, false);
    await page.locator('#photoPermissionCancel').click();
    assert.equal(await page.locator('#xlsxPhotoLinks').isChecked(), true);
  });

  await check('concurrent seen-post batches trim exactly to the database cap', async () => {
    const summary = await worker.evaluate(async () => {
      await XPorterPostDB.clear();
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('xporter_feed_stats');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('posts', 'readwrite');
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
          for (let i = 0; i < XPorterPostDB.MAX_POSTS; i++) {
            tx.objectStore('posts').put({ id: String(100000 + i), last_seen_at: i + 1 });
          }
        });
      } finally { db.close(); }
      await Promise.all([
        XPorterPostDB.upsertPosts([{ id: '900001', text: 'first' }]),
        XPorterPostDB.upsertPosts([{ id: '900002', text: 'second' }])
      ]);
      return XPorterPostDB.getSummary();
    });
    assert.equal(summary.count, summary.maxPosts);
  });

  await check('a failed seen-post update rolls back the entire batch', async () => {
    const result = await worker.evaluate(async () => {
      const originalPut = IDBObjectStore.prototype.put;
      let error = null;
      IDBObjectStore.prototype.put = function (value, ...args) {
        if (this.name === 'posts' && value.id === '900001') throw new Error('simulated put failure');
        return originalPut.call(this, value, ...args);
      };
      try {
        await XPorterPostDB.upsertPosts([{ id: '900003', text: 'must roll back' }, { id: '900001' }]);
      } catch (failure) { error = failure.message; }
      finally { IDBObjectStore.prototype.put = originalPut; }
      const rows = await XPorterPostDB.getAllPosts();
      return { error, partialRow: rows.some(row => row.id === '900003') };
    });
    assert.equal(result.error, 'simulated put failure');
    assert.equal(result.partialRow, false, 'a failed batch must not leave its earlier inserts committed');
  });

  assert.deepEqual(errors, [], 'popup must initialize and handle settings without runtime errors');
  assert.equal(failures.length, 0, `${failures.length} quality regressions failed`);
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
