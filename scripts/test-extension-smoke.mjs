#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const EXTENSION_ROOT = path.resolve(process.cwd());
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, 'manifest.json'), 'utf8'));

async function main() {
  const executablePath = process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-smoke-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    // Headless is the fast default; opt into a visible window for UI debugging.
    headless: process.env.XPORTER_SMOKE_HEADED !== '1',
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXTENSION_ROOT}`,
      `--load-extension=${EXTENSION_ROOT}`
    ]
  });

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    }
    assert(serviceWorker.url().startsWith('chrome-extension://'), 'service worker must start');

    const extensionId = new URL(serviceWorker.url()).host;
    const popup = await context.newPage();
    const runtimeErrors = [];
    popup.on('pageerror', error => runtimeErrors.push(error.message));
    popup.on('console', message => {
      if (message.type() === 'error') runtimeErrors.push(message.text());
    });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });

    assert.equal(await popup.locator('#extensionVersion').textContent(), `v${MANIFEST.version}`);
    assert.equal(await popup.locator('#exportMode').inputValue(), 'posts');
    assert.equal(await popup.locator('#outputFormat').inputValue(), 'csv');
    const txtOption = popup.locator('#outputFormat option[value="txt"]');
    assert.equal(await txtOption.textContent(), 'TXT (Posts only)');
    assert.equal(await txtOption.isDisabled(), false, 'posts-only TXT must be available for posts');
    await popup.locator('#exportMode').selectOption('followers');
    assert.equal(await txtOption.isDisabled(), true, 'posts-only TXT must be disabled for user-list exports');
    assert.equal(await popup.locator('#outputFormat').inputValue(), 'csv');
    await popup.locator('#exportMode').selectOption('posts');
    assert.equal(await txtOption.isDisabled(), false);
    // The public mirror — the `Lemelson/xporter` dev repo is private and 404s
    // for users, so a link pointing there is a regression this guards against.
    assert.equal(
      await popup.locator('#githubLink').getAttribute('href'),
      'https://github.com/Lemelson/xporter-extension'
    );

    const settingsResult = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
    assert.equal(settingsResult.settings.quantityLimit, 500);
    assert.equal(settingsResult.settings.localizeExportHeaders, true);

    const invalidDates = await popup.evaluate(() => chrome.runtime.sendMessage({
      type: 'START_EXPORT',
      username: 'test',
      exportMode: 'posts',
      outputFormat: 'csv',
      dateFrom: '2026-07-10',
      dateTo: '2026-07-01'
    }));
    assert.equal(invalidDates.error, 'INVALID_DATE_RANGE');
    const status = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
    assert.equal(status.status, 'idle');

    const localeCodes = ['en', 'ru', 'es', 'de', 'fr', 'pt', 'it', 'tr', 'id', 'hi', 'ja', 'ko', 'zh', 'ar'];
    await popup.evaluate(async () => {
      const now = Date.now();
      await chrome.storage.local.set({
        xporter_settings: { exportMode: 'posts', outputFormat: 'txt', language: 'en' },
        xporter_export_state: {
          username: 'MediaKing',
          userId: '1',
          userInfo: { name: 'Matt Paulson', screenName: 'MediaKing' },
          exportMode: 'posts',
          outputFormat: 'txt',
          status: 'complete',
          running: false,
          tweetCount: 1,
          totalBatches: 1,
          startedAt: now - 1000,
          completedAt: now,
          updatedAt: now,
          settings: { quantityLimit: 500 }
        },
        xporter_tweets_batch_0: [{
          id: '1', text: 'A compact test post', created_at: new Date(now).toISOString(),
          favorite_count: 7, retweet_count: 2, reply_count: 1,
          tweet_url: 'https://x.com/MediaKing/status/1'
        }]
      });
    });

    for (const language of localeCodes) {
      await popup.evaluate(async (lang) => {
        const stored = await chrome.storage.local.get('xporter_settings');
        await chrome.storage.local.set({
          xporter_settings: { ...(stored.xporter_settings || {}), language: lang }
        });
      }, language);
      await popup.reload({ waitUntil: 'domcontentloaded' });
      await popup.locator('#copyBtn').waitFor({ state: 'visible' });
      const layout = await popup.evaluate(() => {
        const download = document.getElementById('downloadBtn');
        const copy = document.getElementById('copyBtn');
        const downloadLabel = download.querySelector('span');
        const copyLabel = copy.querySelector('span');
        const box = element => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        };
        return {
          format: document.getElementById('outputFormat').value,
          downloadHidden: download.classList.contains('hidden'),
          copyHidden: copy.classList.contains('hidden'),
          download: box(download),
          copy: box(copy),
          labelsFit: [downloadLabel, copyLabel].every(label =>
            label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1
          )
        };
      });
      assert.equal(layout.format, 'txt', `${language}: TXT format must stay selected`);
      assert.equal(layout.downloadHidden, false, `${language}: Download must be visible`);
      assert.equal(layout.copyHidden, false, `${language}: Copy must be visible`);
      assert(
        Math.abs(layout.download.width - layout.copy.width) < 0.1 &&
        Math.abs(layout.download.height - layout.copy.height) < 0.1,
        `${language}: action tiles must be equal`
      );
      assert.equal(layout.labelsFit, true, `${language}: labels must fit without clipping`);
    }

    await popup.evaluate(() => {
      globalThis.__xporterCopiedText = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { async writeText(text) { globalThis.__xporterCopiedText = text; } }
      });
    });
    await popup.locator('#copyBtn').click();
    await popup.waitForFunction(() => globalThis.__xporterCopiedText.includes('PROFILE'));
    assert.match(await popup.evaluate(() => globalThis.__xporterCopiedText), /Post: \(A compact test post\)/);

    await popup.locator('[data-tab="settings"]').click();
    await popup.locator('#tab-settings').waitFor({ state: 'visible' });
    await popup.locator('[data-tab="about"]').click();
    await popup.locator('#tab-about').waitFor({ state: 'visible' });

    const xPage = await context.newPage();
    await xPage.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await xPage.waitForFunction(() => window.__XPORTER_INTERCEPTOR_INSTALLED__ === true, null, {
      timeout: 10_000
    });
    const injection = await xPage.evaluate(() => ({
      interceptor: window.__XPORTER_INTERCEPTOR_INSTALLED__ === true,
      feedParser: typeof window.XPorterFeedParser?.extractPosts === 'function'
    }));
    assert.deepEqual(injection, { interceptor: true, feedParser: true });

    assert.deepEqual(runtimeErrors, [], `popup runtime errors: ${runtimeErrors.join('; ')}`);
    console.log(JSON.stringify({
      extensionId,
      version: MANIFEST.version,
      popup: 'ok',
      serviceWorker: 'ok',
      contentScripts: 'ok',
      invalidDateGuard: 'ok',
      txtActions: `ok (${localeCodes.length} locales)`
    }, null, 2));
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
