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
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#postSelectionCount').textContent.includes('5'));
    assert.equal(await page.locator('#textScale').count(), 1, 'independent text size control exists');
    await page.locator('#tabBtnSettings').click();
    await page.locator('#sizeSettings').evaluate(el => { el.open = true; });
    assert(await page.locator('#uiScale').evaluate(e => !!(document.querySelector('#openThemePicker').compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)), 'scales follow theme picker');
    const measure = () => page.locator('#quantityLimit').evaluate(e => ({font:parseFloat(getComputedStyle(e).fontSize), width:document.body.getBoundingClientRect().width}));
    const before = await measure();
    assert.equal(await page.locator('#textScale').getAttribute('type'), 'range');
    await page.locator('#textScale').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => !document.querySelector('#textScale').disabled);
    await page.waitForFunction(() => document.body.style.getPropertyValue('--text-scale') === '1.03');
    assert.equal(await page.locator('#textScaleValue').textContent(), '105%');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.body.style.getPropertyValue('--text-scale') === '1.18');
    const after = await measure();
    assert(Math.abs(after.font / before.font - 1.18) < 0.01, 'six labelled five-percent steps grow text by 18 percent');
    assert.equal(after.width, before.width, 'text size preserves popup width');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#textScale').value === '130');
    assert.equal(await page.locator('#uiScale').inputValue(), '100', 'interface scale is independent');
    await page.locator('#tabBtnSettings').click();
    await page.locator('#sizeSettings').evaluate(el => { el.open = true; });
    assert.equal(await page.locator('#uiScale').getAttribute('type'), 'range');
    for (const id of ['textScale', 'uiScale']) {
      await page.locator(`#${id}`).focus();
      await page.keyboard.press('Home');
      await page.waitForFunction(id => !document.getElementById(id).disabled && document.getElementById(id).value === '80', id);
    }
    await page.waitForFunction(() => Math.abs(Number(document.body.style.getPropertyValue('--text-scale')) * .8 - .88) < .001 && document.body.style.getPropertyValue('--ui-scale') === '0.8');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#uiScale').value === '80' && document.querySelector('#textScale').value === '80');
    await page.locator('#tabBtnSettings').click();
    await page.locator('#sizeSettings').evaluate(el => { el.open = true; });
    await page.locator('#textScale').focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => !document.querySelector('#textScale').disabled);
    await page.locator('#uiScale').focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => !document.querySelector('#uiScale').disabled);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(() => !document.querySelector('#uiScale').disabled);
    }
    await page.waitForFunction(() => document.body.style.getPropertyValue('--ui-scale') === '1.15');
    assert.equal(await page.locator('#textScale').inputValue(), '130', 'interface scaling preserves text setting');
    if (process.env.XPORTER_TEXT_SCALE_SCREENSHOT) {
      await page.locator('#textScale').scrollIntoViewIfNeeded();
      await page.locator('.appearance-settings').screenshot({ path: process.env.XPORTER_TEXT_SCALE_SCREENSHOT });
    }
    await page.locator('#quantityLimit').click();
    await page.keyboard.press('Escape');
    await page.mouse.move(1, 1);
    // A native select can keep :focus-visible after mouse use; test that exact state.
    await page.locator('#quantityLimit').dispatchEvent('pointerdown');
    assert.equal(await page.locator('#quantityLimit').evaluate(e=>getComputedStyle(e).outlineStyle), 'none', 'no persistent pointer ring');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle !== 'none'), 'keyboard focus stays visible');
    console.log('PASS independent persisted text size, unchanged width, lower placement, pointer and keyboard focus');
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
