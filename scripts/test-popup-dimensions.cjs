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
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#postSelectionCount').textContent.includes('5'));
    await page.locator('#tabBtnSettings').click();
    assert.equal(await page.locator('#sizeSettings').count(), 1);
    assert.equal(await page.locator('#sizeSettings').getAttribute('open'), null);
    await page.locator('#sizeSettings summary').click();
    const measure = () => page.evaluate(() => ({width: document.body.getBoundingClientRect().width, height: document.querySelector('#popup').getBoundingClientRect().height, font: parseFloat(getComputedStyle(document.querySelector('#quantityLimit')).fontSize) * Number(document.body.style.getPropertyValue('--ui-scale')), icon: document.querySelector('.tab svg').getBoundingClientRect().width}));
    const change = async (id, value) => {
      await page.locator(`#${id}`).fill(String(value));
      await page.locator(`#${id}`).dispatchEvent('change');
      await page.waitForFunction(id => !document.getElementById(id).disabled, id);
      await page.waitForTimeout(70);
    };
    const base = await measure();
    await change('popupWidth', 150);
    assert.equal((await measure()).width, 525);
    await change('popupWidth', 100);
    await change('popupHeight', 50);
    assert(Math.abs((await measure()).height / base.height - .5) < .02);
    await change('popupHeight', 100);
    await change('uiScale', 130);
    const elements = await measure();
    assert.equal(elements.width, base.width);
    assert(Math.abs(elements.font - base.font) < .1, 'element size preserves text size');
    assert(Math.abs(elements.icon / base.icon - 1.3) < .02);
    await change('textScale', 130);
    assert(Math.abs((await measure()).font / base.font - 1.18) < .02);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#uiScale').value === '130');
    await page.locator('#tabBtnSettings').click();
    assert.equal(await page.locator('#sizeSettings').getAttribute('open'), null);
    await page.locator('#sizeSettings summary').click();
    assert.equal(await page.locator('#textScale').inputValue(), '130');
    for (const id of ['popupWidth', 'popupHeight', 'uiScale', 'textScale']) {
      const slider = page.locator(`#${id}`);
      await slider.scrollIntoViewIfNeeded();
      assert(await slider.evaluate(el => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
      }), `${id} reachable after scrolling`);
    }
    await page.locator('#textScale').locator('..').screenshot({path: '/private/tmp/xporter-size-settings.png'});
    console.log('PASS independent width, height, elements, text and collapsed settings');
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
