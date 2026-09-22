// A browser can cap the native action viewport below the requested popup height.
// Exercise ordinary wheel scrolling; scrollIntoView would bypass overflow:hidden.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
require('./tooling-policy.js').assertBrowserSmokeCanLaunch();
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.XPORTER_WORKSPACE_ROOT || process.cwd();

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-height-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'))
      || await context.waitForEvent('serviceworker', { predicate: w => w.url().startsWith('chrome-extension://') });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;
    const visibleAtCenter = selector => page.locator(selector).evaluate(el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.width > 0 && r.height > 0 && !!hit && (hit === el || el.contains(hit));
    });
    async function wheelUntil(selector, direction) {
      // Stay in the tab's padding: as content scrolls under a stationary mouse,
      // the center can hover a help button and legitimately scroll its popover.
      await page.mouse.move(8, 230);
      for (let i = 0; i < 32; i++) {
        if (await visibleAtCenter(selector)) return;
        const distance = await page.locator(selector).evaluate(el => {
          const r = el.getBoundingClientRect();
          return r.top + r.height / 2 - innerHeight / 2;
        });
        await page.mouse.wheel(0, Math.abs(distance) > 30
          ? Math.max(-250, Math.min(250, distance)) : direction * 100);
        await page.waitForTimeout(70);
      }
      if (!await visibleAtCenter(selector)) {
        console.log(await page.evaluate(selector => ({ selector, scrollY,
          target: document.querySelector(selector).getBoundingClientRect().toJSON(),
          shell: document.querySelector('#popup').getBoundingClientRect().toJSON(),
          scrollers: [...document.querySelectorAll('.tab-content,.home-content')].filter(el=>el.clientHeight)
            .map(el=>({id:el.id,top:el.scrollTop,height:el.clientHeight,total:el.scrollHeight,rect:el.getBoundingClientRect().toJSON()}))
        }), selector));
        if (process.env.XPORTER_HEIGHT_SCREENSHOT) {
          await page.screenshot({ path: process.env.XPORTER_HEIGHT_SCREENSHOT });
        }
        assert.fail(`${selector} must be reachable using the wheel`);
      }
    }
    let cases = 0;
    for (const language of ['en', 'ar']) for (const uiScale of [100, 130]) {
      for (const height of [400, 480, 600]) {
        const tag = `${language}/${uiScale}%/${height}px`;
        await worker.evaluate(settings => chrome.storage.local.set({ xporter_settings: settings }),
          { language, uiScale, textScale: 100, popupWidth: 100, popupHeight: 100, theme: 'dark', ladybugEnabled: false });
        await page.setViewportSize({ width: 350, height });
        await page.goto(url);
        await page.waitForFunction(lang => document.documentElement.lang === lang
          && document.getElementById('postSelectionCount')?.textContent.includes('5'), language);
        await page.evaluate(() => document.fonts.ready);
        // The fixed viewport represents the host's cap. Use native-action CSS,
        // since ordinary tabs have different responsive size rules.
        await page.evaluate(() => document.documentElement.classList.add('action-popup'));
        await page.waitForTimeout(150);
        await wheelUntil('#signInBtn', 1);
        await wheelUntil('#tabBtnSettings', -1);
        await page.locator('#tabBtnSettings').click();
        await wheelUntil('#feedDbToggle', 1);
        await wheelUntil('#tabBtnAbout', -1);
        await page.locator('#tabBtnAbout').click();
        await wheelUntil('#rateAboutBtn', 1);
        await wheelUntil('#tabBtnHome', -1);
        await page.locator('#tabBtnHome').click();
        await wheelUntil('#signInBtn', 1);
        if (height === 600) {
          assert.equal(await page.evaluate(() => scrollY), 0, `${tag}: full-height host keeps the shell stationary`);
        }
        console.log(`PASS ${tag}: Home action, Settings and About reachable by wheel`);
        cases++;
      }
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${cases} constrained native-layout cases`);
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
