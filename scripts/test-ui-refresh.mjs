#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';

toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.XPORTER_UI_ROOT || process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-ui-'));
const output = process.env.XPORTER_UI_OUTPUT || '/private/tmp/xporter-ui-qa';
fs.mkdirSync(output, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(),
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  // Seed only the renderer's worker state; never call START_EXPORT.
  const showStatus = payload => worker.evaluate(async payload => {
    currentExport = { ...payload, settings: { quantityLimit: payload.quantityLimit || 0 }, startedAt: Date.now() };
    await chrome.runtime.sendMessage(payload);
  }, payload);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 350, height: 600 });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.waitForTimeout(1500);
  await page.locator('#usernameInput').fill('AteoBreaking');
  await page.screenshot({ path: path.join(output, 'popup-setup.png'), fullPage: false });
  const state = {
    type: 'EXPORT_STATUS_UPDATE', running: true, status: 'fetching',
    username: 'AteoBreaking', exportMode: 'posts', tweetCount: 208, quantityLimit: 0
  };
  await showStatus(state);
  await page.locator('#stopBtn').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, 'popup-running.png'), fullPage: false });
  const status = await page.locator('#exportStatus').boundingBox();
  assert(status.y + status.height <= 600, 'active status and Stop must fit in the initial popup viewport');
  assert(status.y < (await page.locator('#exportMode').boundingBox()).y,
    'active status must precede setup controls');
  console.log('PASS active export stays in view');

  const languages = fs.readdirSync(path.join(root, 'popup/locales')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  for (const language of languages) {
    for (const theme of ['dark', 'light']) {
      for (const width of [320, 350]) {
        await page.setViewportSize({ width, height: 600 });
        await page.evaluate(async ({ language, theme }) => {
          const stored = await chrome.storage.local.get('xporter_settings');
          await chrome.storage.local.set({ xporter_settings: { ...stored.xporter_settings, language, theme } });
        }, { language, theme });
        await worker.evaluate(() => { currentExport = null; });
        await page.reload();
        await page.waitForFunction(lang => document.documentElement.lang === lang && document.getElementById('postSelectionCount').textContent.includes('5'), language);
        const helpers = page.locator('.post-type-help');
        assert.equal(await helpers.count(), 5);
        await helpers.first().focus();
        await page.keyboard.press('Enter');
        assert.equal(await helpers.first().locator('.help-pop').isVisible(), true);
        assert.equal(await page.locator('#includeOriginalPosts').isChecked(), true);
        await page.keyboard.press('Escape');
        assert.equal(await helpers.first().locator('.help-pop').isVisible(), false);
        await page.locator('label:has(#includeQuotes)').click();
        assert.equal(await page.locator('#includeQuotes').isChecked(), false);
        await page.locator('label:has(#includeQuotes)').click();
        assert.equal(await page.locator('#includeQuotes').isChecked(), true);
        await page.locator('label:has(#dateCheck)').click();
        assert.equal(await page.locator('#dateFields').isVisible(), true);
        await page.locator('label:has(#dateCheck)').click();
        await page.evaluate(() => (window.scrollTo(0, 0), document.getElementById('homeContent').scrollTop = 0));
        const overflow = await page.evaluate(() => ({
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          clipped: [...document.querySelectorAll('#tab-home input, #tab-home select, #tab-home button, .tab')]
            .filter(el => { const r = el.getBoundingClientRect(); return r.width > 1 && (r.left < -1 || r.right > innerWidth + 1); })
            .map(el => el.id || el.className)
        }));
        assert(overflow.scrollWidth <= width, JSON.stringify({ language, theme, ...overflow }));
        assert.deepEqual(overflow.clipped, [], `${language}/${theme}/${width}: controls must fit`);
        if (width === 350 && ['en', 'ru'].includes(language)) {
          // Screenshot fixture: authenticated appearance, without using a real account.
          await page.locator('#authWarning').evaluate(el => el.classList.add('hidden'));
          await page.locator('#usernameInput').fill('AteoBreaking');
          await page.evaluate(() => (window.scrollTo(0, 0), document.getElementById('homeContent').scrollTop = 0));
          await page.screenshot({ path: path.join(output, `popup-${language}-${theme}.png`) });
        }
        await showStatus({ ...state, searchPhase: 'waiting' });
        await page.locator('#stopBtn').waitFor({ state: 'visible' });
        await page.evaluate(() => (window.scrollTo(0, 0), document.getElementById('homeContent').scrollTop = 0));
        const active = await page.locator('#exportStatus').boundingBox();
        assert(active.y + active.height < 600, `${language}/${theme}/${width}: running status must fit`);
        if (width === 350 && ['en', 'ru'].includes(language)) {
          await page.waitForTimeout(450);
          await page.screenshot({ path: path.join(output, `running-${language}-${theme}.png`) });
        }
      }
    }
  }
  console.log(`PASS setup, per-type keyboard help, selection, dates and active status: ${languages.length} locales × 2 themes × 2 widths`);

  for (const status of ['stopped', 'complete', 'error']) {
    await showStatus({
      ...state, status, running: false, canResume: true, error: 'NETWORK_ERROR'
    });
    assert.equal(await page.locator('#downloadBtn').isVisible(), true, `${status}: collected posts must stay downloadable`);
    const result = await page.locator('#exportStatus').boundingBox();
    assert(result.y + result.height < 600, `${status}: result actions must fit`);
  }
  console.log('PASS stopped, completed and error states retain Download and result actions');

  // Serve a local page fixture at X's URL so the actual content script loads.
  // No requests reach X and no export is started.
  await context.route('https://x.com/**', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><head><title>Local XPorter UI fixture</title></head><body style="margin:0;background:#0e1116;color:#8994a4;font:16px system-ui"><main style="max-width:550px;margin:60px auto"><h1>Local UI preview</h1><p>Export status with simulated data.</p></main></body></html>'
  }));
  const surface = await context.newPage();
  surface.on('pageerror', error => errors.push(error.message));
  await surface.setViewportSize({ width: 1440, height: 900 });
  await surface.goto('https://x.com/search?q=local-ui-fixture');
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://x.com/search*' }))[0].id);
  const sendOverlay = async payload => {
    const response = await worker.evaluate(({ tabId, payload }) => chrome.tabs.sendMessage(tabId, {
      type: 'XPORTER_SEARCH_CAPTURE_STATUS', ...payload
    }), { tabId, payload });
    assert.equal(response.success, true, JSON.stringify(response));
  };
  const overlay = surface.locator('#xporter-capture-overlay');
  for (const language of languages) {
    const tr = JSON.parse(fs.readFileSync(path.join(root, 'popup/locales', `${language}.json`)));
    const i18n = { lang: language, dir: language === 'ar' ? 'rtl' : 'ltr', title: tr.ovTitle,
      note: tr.ovNote, stop: tr.ovStop, stopping: tr.ovStopping, collapse: tr.ovCollapse,
      expand: tr.ovExpand, noLimit: tr.ovNoLimit, rateLimited: tr.ovRateLimited };
    for (const width of [320, 1440]) {
      await surface.setViewportSize({ width, height: 900 });
      const payload = { tweetCount: 208, dateFrom: '2025-04-29', dateTo: '2025-11-29',
        phase: tr.searchWaiting, quantityLimit: 1200, progressPct: 17, i18n };
      await sendOverlay(payload);
      const box = await overlay.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900,
        `${language}/${width}: overlay stays within viewport`);
      assert.equal(await overlay.locator('[data-xporter-pct]').textContent(), '17%');
      const toggle = overlay.locator('.xporter-capture-toggle');
      await toggle.focus();
      await surface.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await overlay.locator('[data-xporter-stop]').isVisible(), false);
      assert.equal(await overlay.locator('.xporter-capture-bar').isVisible(), true);
      if (language === 'en' && width === 1440) await overlay.screenshot({ path: path.join(output, 'overlay-collapsed.png') });
      await surface.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      if (['en', 'ru'].includes(language) && width === 1440) await overlay.screenshot({ path: path.join(output, `overlay-${language}.png`) });
      await sendOverlay({ ...payload, quantityLimit: 0, progressPct: null });
      assert.equal(await overlay.locator('[data-xporter-pct]').textContent(), '');
      await surface.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await overlay.locator('[data-xporter-bar]').evaluate(el => getComputedStyle(el).animationName), 'none');
      await surface.emulateMedia({ reducedMotion: 'no-preference' });
      await sendOverlay({ ...payload, pauseUntil: Date.now() + 60_000 });
      assert.equal(await overlay.locator('[data-xporter-bar]').evaluate(el => getComputedStyle(el).animationName), 'none');
    }
  }
  // User appearance settings also apply to the real in-page overlay.
  const en=JSON.parse(fs.readFileSync(path.join(root,'popup/locales/en.json')));
  for (const theme of ['dark','light']) for (const simplifiedDesign of [false,true]) for (const uiScale of [85,100,115,130]) {
    for (const width of [320,1440]) {
      await surface.setViewportSize({ width, height: 600 });
      await sendOverlay({ tweetCount: 208, progressPct: 17, phase: 'Waiting for X…',
        dateFrom:'2025-04-29',dateTo:'2025-11-29', i18n:{lang:'en',dir:'ltr',title:en.ovTitle,note:en.ovNote,stop:en.ovStop,collapse:en.ovCollapse,expand:en.ovExpand,appearance:{theme,simplifiedDesign,uiScale}} });
      const rect = await overlay.boundingBox();
      assert(rect.x >= -1 && rect.x+rect.width <= width+1 && rect.y >= -1 && rect.y+rect.height <= 601,
        `overlay ${theme}/${simplifiedDesign}/${uiScale}/${width}: ${JSON.stringify(rect)}`);
      assert.equal(await overlay.evaluate(el=>el.classList.contains('xporter-capture-simple')), !simplifiedDesign);
      assert.equal(await overlay.evaluate(el=>el.classList.contains('xporter-capture-light')), theme === 'light');
      if (width===1440 && uiScale===100) {
        await overlay.screenshot({path:path.join(output,`overlay-${theme}-${simplifiedDesign?'simple':'blue'}.png`)});
        if(theme==='dark' && !simplifiedDesign) fs.writeFileSync(path.join(output,'overlay.html'),await surface.evaluate(()=>document.getElementById('xporter-capture-overlay-style').outerHTML+document.getElementById('xporter-capture-overlay').outerHTML));
      }
    }
  }
  await overlay.locator('[data-xporter-stop]').click();
  assert.equal(await overlay.locator('[data-xporter-stop]').isDisabled(), true);
  console.log(`PASS real content-script overlay: ${languages.length} locales, desktop/mobile, collapse, unknown progress, rate limit, reduced motion and Stop`);
  assert.deepEqual(errors, []);

} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
