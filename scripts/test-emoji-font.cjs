// Real Chromium font selection, including native option text and locale changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./tooling-policy.js').assertBrowserSmokeCanLaunch();
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
(async () => {
  const profile = fs.mkdtempSync('/private/tmp/xporter-emoji-test-');
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: chromium.executablePath(), args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error' || msg.type() === 'warning') console.log(msg.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 350, height: 600 });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
    await page.waitForFunction(() => document.querySelector('#langCode').textContent === 'EN');
    await page.evaluate(() => document.fonts.ready);
    const cdp = await context.newCDPSession(page);
    async function fonts(selector) {
      const { root: doc } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.nodeId, selector });
      return (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    }
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.emojiPlatform), 'apple');
    assert((await fonts('#langFlag')).some(f => !f.isCustomFont && f.familyName === 'Apple Color Emoji'), 'Mac keeps its native emoji font');
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', {get: () => 'Win32'});
      Object.defineProperty(navigator, 'userAgentData', {get: () => ({platform: 'Windows'})});
    });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.emojiPlatform === 'bundled');
    await page.evaluate(() => document.fonts.ready);
    assert((await fonts('#langFlag')).some(f => f.isCustomFont && f.familyName === 'XPorter UI Emoji'), 'header flag must use the bundled font, not OS emoji');
    const entries = JSON.parse(fs.readFileSync(path.join(root, 'popup/emoji/manifest.json'))).emoji;
    await page.evaluate(entries => {
      const panel = document.createElement('div');
      panel.id = 'emoji-proof';
      panel.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;color:#111;padding:20px;overflow:auto;';
      entries.forEach(({emoji}, index) => {
        const row = document.createElement('div');
        row.style.cssText = 'font-size:20px;line-height:26px;';
        row.className = 'lang-option-flag';
        const span = document.createElement('span');
        span.id = `emoji-proof-${index}`;
        span.textContent = emoji;
        const native = document.createElement('span');
        native.style.fontFamily = 'Apple Color Emoji';
        native.textContent = emoji;
        row.append(span, '  ', native, ` ${index + 1}`);
        panel.append(row);
      });
      const select = document.createElement('select');
      select.style.fontFamily = getComputedStyle(document.querySelector('#exportSpeed')).fontFamily;
      select.id = 'emoji-proof-select';
      select.innerHTML = '<option>⚠️ Warning</option>';
      panel.append(select);
      document.body.append(panel);
    }, entries);
    await page.evaluate(() => document.fonts.ready);
    for (let i = 0; i < entries.length; i++) {
      const used = await fonts(`#emoji-proof-${i}`);
      assert.deepEqual(used.map(f => [f.familyName, f.isCustomFont, f.glyphCount]), [['XPorter UI Emoji', true, 1]], `${entries[i].emoji}: one embedded glyph, no regional-letter fallback`);
    }
    const pixels = await page.evaluate(entries => entries.map(({emoji}) => {
      const canvas = document.createElement('canvas');
      canvas.width = 100; canvas.height = 100;
      const ctx = canvas.getContext('2d');
      ctx.font = '48px "XPorter UI Emoji"';
      ctx.fillText(emoji, 10, 65);
      const data = ctx.getImageData(0, 0, 100, 100).data;
      let colored = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 128 && Math.max(data[i], data[i+1], data[i+2]) - Math.min(data[i], data[i+1], data[i+2]) > 20) colored++;
      }
      return colored;
    }), entries);
    pixels.forEach((count, i) => assert(count > 50, `${entries[i].emoji}: bitmap must actually paint colored pixels`));
    assert((await fonts('#emoji-proof-select')).some(f => f.isCustomFont), 'native select uses embedded emoji');
    await page.screenshot({ path: '/private/tmp/xporter-emoji-proof.png' });
    await page.locator('#emoji-proof').evaluate(el => el.remove());
    const geometry = () => page.evaluate(() => Object.fromEntries(
      ['#popup', '.header', '#langBtn', '#tabBtnSettings'].map(selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return [selector, {width:r.width, height:r.height, x:r.x, y:r.y}];
      })));
    const after = await geometry();
    await page.evaluate(() => { document.querySelector('link[href="emoji.css"]').disabled = true; });
    await page.waitForTimeout(100);
    const before = await geometry();
    for (const selector of Object.keys(before)) for (const key of Object.keys(before[selector])) {
      assert(Math.abs(before[selector][key] - after[selector][key]) <= 1, `${selector} ${key}: preserve geometry`);
    }
    await page.evaluate(() => { document.querySelector('link[href="emoji.css"]').disabled = false; });
    await page.locator('#langBtn').click();
    await page.locator('.lang-option').filter({ hasText: '中文' }).click();
    await page.waitForFunction(() => document.querySelector('#langCode').textContent === 'ZH');
    assert((await fonts('#langFlag')).some(f => f.isCustomFont), 'language changes keep bundled flags');
    assert.deepEqual(errors, []);
    console.log(`PASS ${entries.length} embedded emoji, flag ligatures, native select and language change`);
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
