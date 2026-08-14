#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';

const { assertBrowserSmokeCanLaunch } = toolingPolicy;

const EXTENSION_ROOT = path.resolve(
  process.env.XPORTER_EXTENSION_ROOT || process.cwd()
);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, 'manifest.json'), 'utf8'));

async function inspectViewportHelp(locator) {
  await locator.hover();
  return locator.evaluate((trigger) => {
    const tooltip = trigger.querySelector(':scope > .help-pop');
    const tooltipRect = tooltip.getBoundingClientRect();
    const tabsRect = document.querySelector('.tabs').getBoundingClientRect();
    const footerRect = document.querySelector('.footer').getBoundingClientRect();
    const style = getComputedStyle(tooltip);
    const footerSafeTop = footerRect.top > 0 && footerRect.top < innerHeight
      ? footerRect.top - 8
      : innerHeight - 8;
    return {
      top: tooltipRect.top,
      bottom: tooltipRect.bottom,
      triggerBottom: trigger.getBoundingClientRect().bottom,
      safeTop: Math.max(8, tabsRect.bottom),
      safeBottom: Math.min(innerHeight - 8, footerSafeTop),
      contentFits: tooltip.scrollHeight <= tooltip.clientHeight + 1,
      canScroll: style.overflowY === 'auto' && style.pointerEvents !== 'none'
    };
  });
}

async function assertPopupFooterFitsViewport(page, label) {
  const layout = await page.evaluate(() => {
    const popupRect = document.getElementById('popup').getBoundingClientRect();
    const footerRect = document.querySelector('.footer').getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      popupBottom: popupRect.bottom,
      footerBottom: footerRect.bottom
    };
  });
  assert(
    Math.abs(layout.popupBottom - layout.viewportHeight) <= 1,
    `${label}: popup shell must reach the bottom of the viewport: ${JSON.stringify(layout)}`
  );
  assert(
    Math.abs(layout.footerBottom - layout.popupBottom) <= 1,
    `${label}: footer must be the popup shell's bottom edge: ${JSON.stringify(layout)}`
  );
}

async function main() {
  assertBrowserSmokeCanLaunch();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-smoke-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    ignoreDefaultArgs: ['--disable-extensions'],
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
    let mediaFetch = 'not requested';
    if (process.env.XPORTER_SMOKE_MEDIA_URL) {
      const mediaResult = await serviceWorker.evaluate(async (url) => {
        const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          byteLength: bytes.length
        };
      }, process.env.XPORTER_SMOKE_MEDIA_URL);
      assert.equal(mediaResult.ok, true, `photo CDN returned ${mediaResult.status}`);
      assert.match(mediaResult.contentType, /^image\/(?:jpeg|png|gif)/);
      assert(mediaResult.byteLength > 1000, 'photo response must contain real image bytes');
      mediaFetch = `${mediaResult.contentType}, ${mediaResult.byteLength} bytes`;
    }
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        xporter_current_account: {
          name: 'Lucas Strand',
          username: 'bylemelson',
          avatarUrl: ''
        }
      });
    });
    const warmupPopup = await context.newPage();
    await warmupPopup.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });
    await warmupPopup.locator('#authWarning').waitFor({ state: 'visible', timeout: 5_000 });
    await warmupPopup.close();
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        xporter_settings: {
          exportMode: 'bookmarks',
          outputFormat: 'csv',
          language: 'en'
        }
      });
    });
    const restoredBookmarksPopup = await context.newPage();
    await restoredBookmarksPopup.setViewportSize({ width: 350, height: 600 });
    await restoredBookmarksPopup.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });
    await restoredBookmarksPopup.locator('#authWarning').waitFor({
      state: 'visible',
      timeout: 5_000
    });
    await restoredBookmarksPopup.waitForTimeout(1_000);
    assert.equal(
      await restoredBookmarksPopup.locator('#exportMode').inputValue(),
      'bookmarks',
      'the saved Bookmarks mode must be restored'
    );
    assert.equal(
      await restoredBookmarksPopup.locator('#bookmarksBetaDialog').count(),
      0,
      'the retired Bookmarks Beta acknowledgement must not remain in the popup'
    );
    await assertPopupFooterFitsViewport(restoredBookmarksPopup, 'restored Bookmarks mode');
    await restoredBookmarksPopup.close();
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        xporter_settings: {
          exportMode: 'posts',
          outputFormat: 'csv',
          language: 'en'
        }
      });
    });
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 350, height: 600 });
    const runtimeErrors = [];
    popup.on('pageerror', error => runtimeErrors.push(error.message));
    popup.on('console', message => {
      if (message.type() === 'error') runtimeErrors.push(message.text());
    });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });
    if (process.env.XPORTER_SMOKE_THEME === 'light') {
      await popup.locator('#themeToggle').click();
      await popup.waitForFunction(() => document.body.classList.contains('light'));
    }

    assert.equal(await popup.locator('#extensionVersion').textContent(), `v${MANIFEST.version}`);
    assert.equal(await popup.locator('.footer-build-date').textContent(), 'Aug 15, 2026');
    assert.equal(await popup.locator('#exportMode').inputValue(), 'posts');
    assert.equal(await popup.locator('#outputFormat').inputValue(), 'csv');
    const txtOption = popup.locator('#outputFormat option[value="txt"]');
    assert.equal(await txtOption.textContent(), 'TXT');
    assert.equal(await txtOption.isDisabled(), false, 'posts-only TXT must be available for posts');
    await popup.locator('#usernameInput').fill('example');
    await popup.locator('#exportMode').selectOption('bookmarks');
    assert.doesNotMatch(
      await popup.locator('#exportMode option[value="bookmarks"]').textContent(),
      /Beta/i
    );
    await popup.waitForFunction(
      () => document.querySelector('#usernameInput')?.disabled === true
    );
    assert.equal(await popup.locator('#usernameInput').isDisabled(), true,
      'Bookmarks must not accept another profile username');
    assert.equal(await popup.locator('#usernameField').isVisible(), false,
      'Bookmarks must replace the irrelevant username input with an account card');
    assert.equal(await popup.locator('#bookmarksAccountCard').isVisible(), true);
    assert.equal(await popup.locator('#bookmarksAccountName').textContent(), 'Lucas Strand');
    assert.equal(await popup.locator('#bookmarksAccountHandle').textContent(), '@bylemelson');
    assert.equal(await popup.locator('.bookmarks-account-owner').textContent(), 'Your account');
    assert.equal(await popup.locator('#usernamePrefix').isVisible(), false,
      'the @ prefix must not imply that Bookmarks belong to a typed profile');
    assert.equal(await txtOption.isDisabled(), false,
      'Bookmarks are post rows and must support AI-friendly TXT');
    assert.equal(await popup.locator('#postsOnlyOptions').isVisible(), false,
      'profile-only date filters must not appear for personal Bookmarks');
    await assertPopupFooterFitsViewport(popup, 'Bookmarks mode');
    await popup.setViewportSize({ width: 350, height: 450 });
    const exportModeHelp = popup.locator('[data-i18n-tooltip="exportModeHelp"]');
    const exportModeTooltipLayout = await inspectViewportHelp(exportModeHelp);
    assert(
      exportModeTooltipLayout.top >= exportModeTooltipLayout.safeTop &&
        exportModeTooltipLayout.bottom <= exportModeTooltipLayout.safeBottom,
      `the export-mode explanation must stay between the tabs and footer: ${JSON.stringify(exportModeTooltipLayout)}`
    );
    assert(
      exportModeTooltipLayout.contentFits || exportModeTooltipLayout.canScroll,
      'the export-mode explanation must expose all mode descriptions'
    );
    await popup.setViewportSize({ width: 350, height: 600 });
    if (process.env.XPORTER_SMOKE_BOOKMARKS_SCREENSHOT) {
      await popup.screenshot({
        path: process.env.XPORTER_SMOKE_BOOKMARKS_SCREENSHOT,
        fullPage: true
      });
    }
    await popup.locator('[data-tab="settings"]').click();
    await popup.locator('#tab-settings').waitFor({ state: 'visible' });
    assert.equal(await popup.locator('#settingsPostsOnly').isVisible(), false,
      'profile Post/Reply/Repost filters must not remove saved bookmarks');
    assert.equal(await popup.locator('#settingsBookmarksOnly').isVisible(), true);
    assert.equal(await popup.locator('#includeBookmarkReplyContext').isChecked(), true);
    assert.equal(await popup.locator('#includeBookmarkArticles').isChecked(), true);
    assert.equal(await popup.locator('#embedBookmarkPhotos').isChecked(), false);
    if (process.env.XPORTER_SMOKE_BOOKMARKS_SETTINGS_SCREENSHOT) {
      await popup.screenshot({
        path: process.env.XPORTER_SMOKE_BOOKMARKS_SETTINGS_SCREENSHOT,
        fullPage: true
      });
    }
    await popup.locator('[data-tab="home"]').click();
    await popup.locator('#exportMode').selectOption('posts');
    await popup.waitForFunction(
      () => document.querySelector('#usernameInput')?.disabled === false
    );
    await popup.locator('#exportMode').selectOption('bookmarks');
    await popup.locator('#exportMode').selectOption('posts');
    assert.equal(await popup.locator('#usernameInput').inputValue(), 'example');
    assert.equal(await popup.locator('#usernameField').isVisible(), true);
    assert.equal(await popup.locator('#bookmarksAccountField').isVisible(), false);
    assert.equal(await popup.locator('#usernamePrefix').isVisible(), true);
    await popup.locator('#exportMode').selectOption('followers');
    await popup.waitForFunction(
      () => document.querySelector('#outputFormat option[value="txt"]')?.disabled === true
    );
    assert.equal(await txtOption.isDisabled(), true, 'posts-only TXT must be disabled for user-list exports');
    assert.equal(await popup.locator('#outputFormat').inputValue(), 'csv');
    await popup.locator('#exportMode').selectOption('verified_followers');
    await assertPopupFooterFitsViewport(popup, 'Verified Followers mode');
    await popup.locator('#exportMode').selectOption('posts');
    await popup.waitForFunction(
      () => document.querySelector('#outputFormat option[value="txt"]')?.disabled === false
    );
    assert.equal(await txtOption.isDisabled(), false);
    // The public mirror — the `Lemelson/xporter` dev repo is private and 404s
    // for users, so a link pointing there is a regression this guards against.
    assert.equal(
      await popup.locator('#githubLink').getAttribute('href'),
      'https://github.com/Lemelson/xporter-extension'
    );

    await popup.locator('[data-tab="about"]').click();
    await popup.locator('#tab-about').waitFor({ state: 'visible' });
    const updates = popup.locator('.update-item');
    assert.equal(await updates.count(), 3, 'About must show the current build and two latest public releases');
    assert.equal(await updates.first().locator('.update-meta-version').textContent(), 'v1.5.9');
    assert.equal(await updates.nth(1).locator('.update-meta-version').textContent(), 'v1.5.8');
    assert.equal(await updates.first().locator('.detail-head .update-meta-version').count(), 0);
    await updates.first().locator('.detail-head').click();
    assert.equal(await updates.first().locator('.detail-head').getAttribute('aria-expanded'), 'true');
    assert.equal(await updates.first().locator('time').getAttribute('datetime'), '2026-08-15');
    assert.equal(await updates.first().locator('time').textContent(), 'August 15, 2026');
    if (process.env.XPORTER_SMOKE_SCREENSHOT) {
      await popup.waitForTimeout(350);
      await popup.screenshot({ path: process.env.XPORTER_SMOKE_SCREENSHOT, fullPage: true });
    }
    await popup.locator('[data-tab="home"]').click();

    const settingsResult = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
    assert.equal(settingsResult.settings.quantityLimit, 500);
    assert.equal(settingsResult.settings.localizeExportHeaders, true);
    assert.equal(settingsResult.settings.includeReplies, false);
    assert.equal(settingsResult.settings.includeAboutAccountDetails, false);
    await popup.locator('[data-tab="settings"]').click();
    await popup.locator('#tab-settings').waitFor({ state: 'visible' });
    const quantityOptions = await popup.locator('#quantityLimit option').evaluateAll(options =>
      options.map(option => ({ value: option.value, text: option.textContent }))
    );
    assert.deepEqual(quantityOptions, [
      { value: '0', text: 'Unlimited (Posts: ≈3,200)' },
      { value: '100', text: '100 posts' },
      { value: '500', text: '500 posts' },
      { value: '1000', text: '1,000 posts' },
      { value: 'custom', text: 'Custom' }
    ]);
    assert.equal(await popup.locator('#includeReplies').isChecked(), false);
    assert.equal(await popup.locator('#includeAboutAccountDetails').isChecked(), false);
    assert.equal(await popup.locator('#aboutAccountSpeedField').isVisible(), false);
    assert.equal(await popup.locator('#aboutAccountMaxRetries').inputValue(), '5');
    assert.equal(await popup.locator('#exportSpeed').inputValue(), 'standard');
    assert.equal(await popup.locator('#userExportSpeed').inputValue(), 'standard');
    assert.equal(await popup.locator('#aboutAccountSpeed').inputValue(), 'standard');
    assert.equal(await popup.locator('#exportSpeedLabel').textContent(), 'Posts & Bookmarks Export Speed');
    assert.equal(await popup.locator('#userExportSpeedLabel').textContent(), 'User Lists Export Speed');
    await popup.locator('#exportSpeed').selectOption('custom');
    await popup.locator('#customSpeedRows').waitFor({ state: 'visible' });
    assert.equal(await popup.locator('#userCustomSpeedRows').isVisible(), false);
    await popup.locator('#customDelaySec').fill('7');
    await popup.locator('#customDelaySec').dispatchEvent('change');
    await popup.locator('#userExportSpeed').selectOption('custom');
    await popup.locator('#userCustomSpeedRows').waitFor({ state: 'visible' });
    await popup.locator('#userCustomDelaySec').fill('19');
    await popup.locator('#userCustomDelaySec').dispatchEvent('change');
    await popup.waitForTimeout(650);
    const independentSpeeds = await popup.evaluate(
      () => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
    );
    assert.equal(independentSpeeds.settings.exportSpeed, 'custom');
    assert.equal(independentSpeeds.settings.customDelaySec, 7);
    assert.equal(independentSpeeds.settings.userExportSpeed, 'custom');
    assert.equal(independentSpeeds.settings.userCustomDelaySec, 19);
    const repliesHelp = popup.locator('[data-i18n-tooltip="includeRepliesHelp"]');
    const repliesHelpLabel = await repliesHelp.getAttribute('aria-label');
    assert.match(repliesHelpLabel, /open X tab does not matter/,
      'the setting must explain that the current profile tab does not select the endpoint');
    assert.match(repliesHelpLabel, /context without increasing the post count/,
      'the setting must explain how foreign parent posts affect rows and totals');
    assert.equal(await repliesHelp.locator('.help-pop strong').count(), 2,
      'the expanded reply explanation must keep two scannable bold summaries');
    const aboutDetailsHelp = popup.locator(
      '[data-i18n-tooltip="includeAboutAccountDetailsHelp"]'
    );
    assert.match(await aboutDetailsHelp.getAttribute('aria-label'), /500 extra requests/);
    assert.match(
      await aboutDetailsHelp.getAttribute('aria-label'),
      /temporary (?:X )?restrictions?/
    );
    await popup.setViewportSize({ width: 350, height: 600 });
    const repliesTooltipLayout = await inspectViewportHelp(repliesHelp);
    assert(
      repliesTooltipLayout.top >= repliesTooltipLayout.safeTop &&
        repliesTooltipLayout.bottom <= repliesTooltipLayout.safeBottom,
      `the expanded reply tooltip must stay inside the popup viewport: ${JSON.stringify(repliesTooltipLayout)}`
    );
    assert(
      repliesTooltipLayout.contentFits || repliesTooltipLayout.canScroll,
      'the expanded reply tooltip must expose all context-counting details'
    );
    const aboutDetailsTooltipLayout = await inspectViewportHelp(aboutDetailsHelp);
    assert(
      aboutDetailsTooltipLayout.top >= aboutDetailsTooltipLayout.safeTop,
      `the detailed-account tooltip must not be hidden behind the popup header or tabs: ${JSON.stringify(aboutDetailsTooltipLayout)}`
    );
    assert(
      aboutDetailsTooltipLayout.bottom <= aboutDetailsTooltipLayout.safeBottom,
      'the detailed-account tooltip must stay inside the popup viewport'
    );
    assert(
      aboutDetailsTooltipLayout.contentFits || aboutDetailsTooltipLayout.canScroll,
      'every translated detailed-account tooltip must expose its full text'
    );
    const localizeHeadersHelp = popup.locator(
      '[data-i18n-tooltip="localizeHeadersHelp"]'
    );
    await localizeHeadersHelp.hover();
    const localizeHeadersTooltipLayout = await localizeHeadersHelp.evaluate((trigger) => {
      const triggerRect = trigger.getBoundingClientRect();
      const tooltipRect = trigger.querySelector(':scope > .help-pop').getBoundingClientRect();
      return { triggerBottom: triggerRect.bottom, tooltipTop: tooltipRect.top };
    });
    assert(
      localizeHeadersTooltipLayout.tooltipTop > localizeHeadersTooltipLayout.triggerBottom,
      'the column-title tooltip must open below its control'
    );
    await popup.locator('label:has(#includeAboutAccountDetails)').click();
    assert.equal(
      await popup.locator('#includeAboutAccountDetails').isChecked(),
      false,
      'the expensive setting must not turn on before confirmation'
    );
    await popup.locator('#aboutRiskDialog').waitFor({ state: 'visible' });
    if (process.env.XPORTER_SMOKE_RISK_SCREENSHOT) {
      await popup.waitForTimeout(200);
      await popup.screenshot({
        path: process.env.XPORTER_SMOKE_RISK_SCREENSHOT,
        fullPage: true
      });
    }
    assert.equal(await popup.locator('#popup').evaluate(element => element.inert), true);
    assert.equal(await popup.locator('#aboutRiskCancel').evaluate(
      element => element === document.activeElement
    ), true, 'the safe action must receive initial focus');
    assert.equal(await popup.locator('#aboutRiskConfirm').isDisabled(), true);
    assert.match(await popup.locator('#aboutRiskConfirm').textContent(), /\(5\)/);
    await popup.locator('#aboutRiskCancel').click();
    assert.equal(await popup.locator('#includeAboutAccountDetails').isChecked(), false);
    assert.equal(await popup.locator('#popup').evaluate(element => element.inert), false);

    await popup.locator('label:has(#includeAboutAccountDetails)').click();
    await popup.locator('#aboutRiskDialog').waitFor({ state: 'visible' });
    await popup.waitForFunction(
      () => document.querySelector('#aboutRiskConfirm')?.disabled === false,
      null,
      { timeout: 6_500 }
    );
    await popup.locator('#aboutRiskConfirm').click();
    assert.equal(await popup.locator('#includeAboutAccountDetails').isChecked(), true);
    await popup.locator('#aboutAccountSpeedField').waitFor({ state: 'visible' });
    if (process.env.XPORTER_SMOKE_SETTINGS_SCREENSHOT) {
      await popup.waitForTimeout(350);
      await popup.screenshot({
        path: process.env.XPORTER_SMOKE_SETTINGS_SCREENSHOT,
        fullPage: true
      });
    }
    await popup.locator('#aboutAccountSpeed').selectOption('custom');
    await popup.locator('#aboutAccountCustomRows').waitFor({ state: 'visible' });
    await popup.locator('#aboutAccountCustomBatchSize').fill('12');
    await popup.locator('#aboutAccountCustomBatchSize').dispatchEvent('change');

    await popup.locator('#aboutAccountMaxRetries').fill('60');
    await popup.locator('#aboutAccountMaxRetries').dispatchEvent('change');
    assert.equal(await popup.locator('#aboutRiskDialog').isVisible(), false);
    await popup.waitForTimeout(650);
    const oneHourRetries = await popup.evaluate(
      () => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
    );
    assert.equal(oneHourRetries.settings.aboutAccountMaxRetries, 60);

    await popup.locator('#aboutAccountMaxRetries').fill('61');
    await popup.locator('#aboutAccountMaxRetries').dispatchEvent('change');
    await popup.locator('#aboutRiskDialog').waitFor({ state: 'visible' });
    await popup.locator('#aboutRiskCancel').click();
    assert.equal(await popup.locator('#aboutAccountMaxRetries').inputValue(), '60');

    await popup.locator('#aboutAccountMaxRetries').fill('120');
    await popup.locator('#aboutAccountMaxRetries').dispatchEvent('change');
    await popup.locator('#aboutRiskDialog').waitFor({ state: 'visible' });
    await popup.waitForFunction(
      () => document.querySelector('#aboutRiskConfirm')?.disabled === false,
      null,
      { timeout: 6_500 }
    );
    await popup.locator('#aboutRiskConfirm').click();
    await popup.waitForTimeout(650);
    const detailedSetting = await popup.evaluate(
      () => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
    );
    assert.equal(detailedSetting.settings.includeAboutAccountDetails, true);
    assert.equal(detailedSetting.settings.aboutAccountSpeed, 'custom');
    assert.equal(detailedSetting.settings.aboutAccountCustomBatchSize, 12);
    assert.equal(detailedSetting.settings.aboutAccountMaxRetries, 120);
    await popup.locator('[data-tab="home"]').click();

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

    // Exercise the real popup rendering contract for an About-details 429:
    // paused with a live retry countdown, then explicitly retrying. The retry
    // must not regress to the generic "Fetching..." label.
    const retryUntil = Date.now() + 30000;
    await serviceWorker.evaluate((until) => chrome.runtime.sendMessage({
      type: 'EXPORT_STATUS_UPDATE',
      running: true,
      status: 'rate_limited',
      username: 'rate-limit-test',
      exportMode: 'following',
      tweetCount: 40,
      quantityLimit: 100,
      retryIn: 30000,
      until,
      kind: 'window',
      attempt: 1
    }), retryUntil);
    await popup.locator('#statusText').waitFor({ state: 'visible' });
    assert.equal(
      await popup.locator('#statusText').textContent(),
      'X rate limit — export paused. Progress is saved.'
    );
    assert.match(await popup.locator('#statusMessage').textContent(), /^retry in 0:\d{2}$/);
    assert.equal(await popup.locator('#progressFill').evaluate(el => el.classList.contains('cooldown')), true);

    await serviceWorker.evaluate(() => chrome.runtime.sendMessage({
      type: 'EXPORT_STATUS_UPDATE',
      running: true,
      status: 'retrying',
      username: 'rate-limit-test',
      exportMode: 'following',
      tweetCount: 40,
      quantityLimit: 100,
      attempt: 1,
      reason: 'RATE_LIMITED',
      batch: 3
    }));
    await popup.waitForFunction(() =>
      document.getElementById('statusMessage')?.textContent.includes('Retrying the request')
    );
    assert.doesNotMatch(await popup.locator('#statusMessage').textContent(), /Fetching/);
    assert.equal(await popup.locator('#progressFill').evaluate(el => el.classList.contains('indeterminate')), true);
    await serviceWorker.evaluate(() => chrome.runtime.sendMessage({
      type: 'EXPORT_STATUS_UPDATE',
      running: false,
      status: 'idle',
      username: 'rate-limit-test',
      exportMode: 'following',
      tweetCount: 40
    }));

    const localeCodes = ['en', 'ru', 'es', 'de', 'fr', 'pt', 'it', 'tr', 'id', 'hi', 'ja', 'ko', 'zh', 'ar'];
    await popup.evaluate(async () => {
      const now = Date.now();
      await chrome.storage.local.set({
        xporter_settings: {
          exportMode: 'posts',
          outputFormat: 'txt',
          language: 'en',
          includeAboutAccountDetails: true,
          aboutAccountSpeed: 'standard',
          aboutAccountMaxRetries: 120
        },
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

      await popup.locator('[data-tab="about"]').click();
      await popup.locator('#tab-about').waitFor({ state: 'visible' });
      if (language === 'ru' && process.env.XPORTER_SMOKE_ABOUT_SCREENSHOT) {
        await popup.screenshot({
          path: process.env.XPORTER_SMOKE_ABOUT_SCREENSHOT,
          fullPage: true
        });
        await popup.locator('.about-details .detail-head').first().click();
        await popup.waitForTimeout(350);
        await popup.screenshot({
          path: process.env.XPORTER_SMOKE_ABOUT_OPEN_SCREENSHOT,
          fullPage: true
        });
        await popup.locator('.about-details .detail-head').first().click();
      }
      const updatesLayout = await popup.evaluate(() => {
        const section = document.querySelector('.about-updates');
        const titles = [...section.querySelectorAll('.update-title')];
        const metadata = [...section.querySelectorAll('.update-meta')];
        return {
          heading: section.querySelector('.details-heading')?.textContent.trim(),
          itemCount: section.querySelectorAll('.update-item').length,
          noHorizontalOverflow: section.scrollWidth <= section.clientWidth + 1 &&
            titles.every(title => title.scrollWidth <= title.clientWidth + 1) &&
            metadata.every(meta => meta.scrollWidth <= meta.clientWidth + 1)
        };
      });
      assert(updatesLayout.heading, `${language}: Last updates heading must be translated`);
      assert.equal(updatesLayout.itemCount, 3, `${language}: release history must keep three entries`);
      assert.equal(updatesLayout.noHorizontalOverflow, true, `${language}: release titles must not overflow`);

      await popup.locator('[data-tab="settings"]').click();
      await popup.locator('#tab-settings').waitFor({ state: 'visible' });
      const speedLayout = await popup.evaluate(() => {
        const section = document.getElementById('tab-settings');
        const labels = [
          document.getElementById('exportSpeedLabel'),
          document.getElementById('userExportSpeedLabel')
        ];
        const retryLabel = document.getElementById('aboutAccountRetriesLabel');
        const retryHint = document.getElementById('aboutRetryEveryMinuteLabel');
        const aboutLabel = document.querySelector(
          '[data-i18n="includeAboutAccountDetails"]'
        );
        const aboutHelp = document.querySelector(
          '[data-i18n-tooltip="includeAboutAccountDetailsHelp"]'
        );
        return {
          noHorizontalOverflow: section.scrollWidth <= section.clientWidth + 1 &&
            labels.every(label => label.scrollWidth <= label.clientWidth + 1) &&
            aboutLabel.scrollWidth <= aboutLabel.clientWidth + 1 &&
            retryLabel.scrollWidth <= retryLabel.clientWidth + 1 &&
            retryHint.scrollWidth <= retryHint.clientWidth + 1,
          postsLabel: labels[0].textContent.trim(),
          userListsLabel: labels[1].textContent.trim(),
          aboutLabel: aboutLabel.textContent.trim(),
          aboutHelp: aboutHelp.getAttribute('aria-label'),
          retryLabel: retryLabel.textContent.trim()
        };
      });
      assert(speedLayout.postsLabel, `${language}: posts speed label must be translated`);
      assert(speedLayout.userListsLabel, `${language}: user-list speed label must be translated`);
      assert(speedLayout.aboutLabel, `${language}: detailed-account label must be translated`);
      assert(speedLayout.retryLabel, `${language}: About retry label must be translated`);
      assert.match(
        speedLayout.aboutHelp,
        /500/,
        `${language}: detailed-account warning must explain the request scale`
      );
      assert.equal(speedLayout.noHorizontalOverflow, true, `${language}: speed controls must not overflow`);
      const translatedAboutTooltipLayout = await inspectViewportHelp(
        popup.locator('[data-i18n-tooltip="includeAboutAccountDetailsHelp"]')
      );
      assert(
        translatedAboutTooltipLayout.top >= translatedAboutTooltipLayout.safeTop,
        `${language}: detailed-account tooltip must stay below the popup chrome: ${JSON.stringify(translatedAboutTooltipLayout)}`
      );
      assert(
        translatedAboutTooltipLayout.bottom <= translatedAboutTooltipLayout.safeBottom,
        `${language}: detailed-account tooltip must stay inside the popup viewport: ${JSON.stringify(translatedAboutTooltipLayout)}`
      );
      assert(
        translatedAboutTooltipLayout.contentFits || translatedAboutTooltipLayout.canScroll,
        `${language}: detailed-account tooltip must expose its full translated text`
      );
      const translatedEmbedTooltipLayout = await inspectViewportHelp(
        popup.locator('#settingsPostsOnly [data-i18n-tooltip="embedPhotosHelp"]')
      );
      assert(
        translatedEmbedTooltipLayout.top > translatedEmbedTooltipLayout.triggerBottom,
        `${language}: the photo-embedding explanation must open below its help button`
      );
      assert(
        translatedEmbedTooltipLayout.bottom <= translatedEmbedTooltipLayout.safeBottom,
        `${language}: the photo-embedding explanation must stay above the viewport/footer edge`
      );
      assert(
        translatedEmbedTooltipLayout.contentFits || translatedEmbedTooltipLayout.canScroll,
        `${language}: the photo-embedding explanation must remain fully readable`
      );

      await popup.locator('#aboutAccountMaxRetries').fill('121');
      await popup.locator('#aboutAccountMaxRetries').dispatchEvent('change');
      await popup.locator('#aboutRiskDialog').waitFor({ state: 'visible' });
      const riskLayout = await popup.locator('#aboutRiskDialog .risk-dialog-card').evaluate((card) => ({
        title: card.querySelector('.risk-dialog-title')?.textContent.trim(),
        body: card.querySelector('.risk-dialog-body')?.textContent.trim(),
        cancel: card.querySelector('#aboutRiskCancel')?.textContent.trim(),
        confirm: card.querySelector('#aboutRiskConfirm')?.textContent.trim(),
        noHorizontalOverflow: card.scrollWidth <= card.clientWidth + 1,
        contentReachable: card.scrollHeight <= card.clientHeight + 1 ||
          getComputedStyle(card).overflowY === 'auto'
      }));
      assert(riskLayout.title, `${language}: risk title must be translated`);
      assert(riskLayout.body, `${language}: risk explanation must be translated`);
      assert(riskLayout.cancel, `${language}: risk cancel action must be translated`);
      assert(riskLayout.confirm, `${language}: risk confirmation action must be translated`);
      assert.equal(riskLayout.noHorizontalOverflow, true,
        `${language}: risk dialog must not overflow horizontally`);
      assert.equal(riskLayout.contentReachable, true,
        `${language}: risk dialog content must remain reachable`);
      await popup.locator('#aboutRiskCancel').click();
      await popup.locator('#aboutRiskDialog').waitFor({ state: 'hidden' });
      await popup.locator('[data-tab="home"]').click();
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
    assert.match(await popup.evaluate(() => globalThis.__xporterCopiedText), /Post: "A compact test post"/);

    await popup.evaluate(async () => {
      const now = Date.now();
      await chrome.storage.local.set({
        xporter_settings: {
          exportMode: 'posts',
          outputFormat: 'csv',
          language: 'en',
          includeReplies: true
        },
        xporter_export_state: {
          username: 'MediaKing',
          userId: '1',
          exportMode: 'posts',
          outputFormat: 'csv',
          status: 'error',
          running: false,
          error: 'REPLIES_UNAVAILABLE',
          tweetCount: 0,
          totalBatches: 0,
          startedAt: now - 1000,
          updatedAt: now,
          settings: { quantityLimit: 100, includeReplies: true }
        },
        xporter_export_history: [{
          id: 'partial-history',
          username: 'MediaKing',
          displayName: 'Matt Paulson',
          exportMode: 'posts',
          itemCount: 100,
          outputFormat: 'csv',
          partialReason: 'replies_unavailable',
          completedAt: now,
          hasData: false
        }]
      });
    });
    await popup.reload({ waitUntil: 'domcontentloaded' });
    await popup.locator('#repliesFallbackActions').waitFor({ state: 'visible' });
    assert.equal(await popup.locator('#continuePostsOnlyBtn').isVisible(), true);
    assert.equal(await popup.locator('#retryRepliesBtn').isVisible(), true);
    assert.equal(await popup.locator('#startBtn').isVisible(), false);
    assert.equal(await popup.locator('#resumeRow').isVisible(), false);

    await popup.locator('[data-tab="settings"]').click();
    await popup.locator('#tab-settings').waitFor({ state: 'visible' });
    await popup.locator('#historyToggle').click();
    await popup.locator('.history-partial-badge').waitFor({ state: 'visible' });
    assert.equal(await popup.locator('.history-partial-badge').textContent(), 'Posts only · replies omitted');
    await popup.locator('[data-tab="about"]').click();
    await popup.locator('#tab-about').waitFor({ state: 'visible' });

    let contentScripts = 'skipped';
    if (process.env.XPORTER_SMOKE_SKIP_X_LOGIN !== '1') {
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
      contentScripts = 'ok';
    }

    assert.deepEqual(runtimeErrors, [], `popup runtime errors: ${runtimeErrors.join('; ')}`);
    console.log(JSON.stringify({
      extensionId,
      version: MANIFEST.version,
      popup: 'ok',
      serviceWorker: 'ok',
      contentScripts,
      bookmarksMode: 'account card, reply context, Articles, photo XLSX',
      mediaFetch,
      quantityPresets: 'X availability disclosed',
      invalidDateGuard: 'ok',
      independentSpeeds: 'ok',
      detailedUserAbout: 'opt-in with warning',
      txtActions: `ok (${localeCodes.length} locales)`,
      lastUpdates: `ok (${localeCodes.length} locales)`,
      repliesFallback: 'ok',
      partialHistory: 'ok'
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
