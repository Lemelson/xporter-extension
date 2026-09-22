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
    await worker.evaluate(() => chrome.storage.local.set({xporter_settings: {uiScale: 80, popupWidth: 150, textScale: 80, language: 'en'}}));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#postSelectionCount').textContent.includes('5'));
    await page.evaluate(() => {
      document.querySelector('#authWarning').classList.add('hidden');
      document.querySelector('#startBtn').classList.remove('hidden');
      document.querySelector('#signInBtn').classList.add('hidden');
    });
    await page.waitForTimeout(100);
    const heights = () => page.evaluate(() => {
      const content = document.querySelector('#homeContent');
      const visible = [...content.children].filter(el => el.getBoundingClientRect().height);
      return { height: document.querySelector('#popup').getBoundingClientRect().height,
        gap: content.getBoundingClientRect().bottom - (visible.at(-1)?.getBoundingClientRect().bottom || 0) };
    });
    const home = await heights();
    assert(home.height < 600, `Compact Home should shrink below 600px, got ${home.height}`);
    assert(home.gap < 30, `Home has ${home.gap}px unused space`);
    for (const tab of ['Settings', 'About', 'Home']) {
      await page.locator(`#tabBtn${tab}`).click();
      await page.waitForTimeout(50);
      assert(Math.abs((await heights()).height - home.height) <= 1, 'tabs keep Home height');
    }
    await page.screenshot({path: '/private/tmp/xporter-home-height.png'});
    console.log('PASS compact Home height and stable Settings/About size', home);
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
