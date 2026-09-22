// Run through approved unsandboxed execution, like the other popup browser checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./tooling-policy.js').assertBrowserSmokeCanLaunch();
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.XPORTER_WORKSPACE_ROOT || process.cwd();
(async () => {
  const profile = fs.mkdtempSync('/private/tmp/xporter-refinement-');
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const url = `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;
    await page.setViewportSize({ width: 350, height: 600 });
    let cases = 0;
    for (const file of fs.readdirSync(path.join(root, 'popup/locales'))) {
      const language = file.replace('.json', '');
      for (const theme of ['light', 'dark']) for (const simplifiedDesign of [false, true]) {
        const tag = `${language}/${theme}/${simplifiedDesign}`;
        await worker.evaluate(async settings => chrome.storage.local.set({ xporter_settings: settings }),
          { language, theme, simplifiedDesign, uiScale: 100, ladybugEnabled: false });
        await page.goto(url);
        await page.waitForFunction(lang => document.documentElement.lang === lang, language);
        await page.locator('#tabBtnAbout').click();
        const clipped = await page.evaluate(() => {
          const failures = [];
          for (const head of document.querySelectorAll('.detail-head')) {
            head.click();
            const body = head.closest('.detail-item').querySelector('.detail-body-inner');
            if (body.scrollHeight > body.clientHeight + 1) failures.push(head.textContent.trim());
            const meta = body.querySelector('.update-meta');
            if (meta && (!meta.querySelector('time').textContent.trim() ||
              meta.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom + 1)) failures.push('release metadata');
            // A longer future translation must remain readable, too.
            const p = body.querySelector('p');
            const old = p.textContent;
            p.textContent = old.repeat(8);
            if (body.scrollHeight > body.clientHeight + 1) failures.push('long translation');
            p.textContent = old;
            head.click();
          }
          return failures;
        });
        assert.deepEqual(clipped, [], `${tag}: disclosures must expose complete text immediately`);
        await page.locator('#tabBtnSettings').click();
        await page.locator('#feedDbToggle').click();
        assert(await page.locator('#feedDbSummary').isVisible(), `${tag}: empty collection guidance`);
        assert(!await page.locator('#downloadFeedCsv').isVisible(), `${tag}: no unavailable empty collection actions`);
        const overflow = await page.locator('#feedDbToggle').evaluate(e => e.scrollWidth > e.clientWidth + 1);
        assert(!overflow, `${tag}: collection heading must wrap`);
        cases++;
      }
    }
    await page.locator('#tabBtnAbout').click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#rateAboutBtn').hover();
    assert.equal(await page.locator('.about-rate-cta').evaluate(e => getComputedStyle(e).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert(await page.locator('.about-rate-cta').evaluate(e => parseFloat(getComputedStyle(e).transitionDuration) <= 0.001));
    console.log(`PASS: ${cases} locale/theme/style cases; immediate and long disclosure content, release metadata, empty collection, reduced-motion stars.`);
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
