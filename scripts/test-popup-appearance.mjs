#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';
toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.XPORTER_TEST_EXTENSION_ROOT || process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-appearance-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(),
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  const placeAt = (locator, top) => locator.evaluate((el, top) => {
    const scroller = el.closest('.home-content, .tab-content') || document.scrollingElement;
    const zoom = Number(document.body.style.getPropertyValue('--ui-scale')) || 1;
    scroller.scrollTop += (el.getBoundingClientRect().top - top) / zoom;
  }, top);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 350, height: 600 });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await page.waitForFunction(() => document.getElementById('postSelectionCount').textContent.includes('5'));
  const earlyHover = await page.locator('[data-i18n-tooltip="exportModeHelp"]').evaluate(trigger => {
    const pop = trigger.querySelector('.help-pop');
    pop.remove();
    trigger.dispatchEvent(new Event('pointerenter'));
    const openedWithoutContent = trigger.classList.contains('help-open');
    trigger.append(pop);
    return openedWithoutContent;
  });
  assert.equal(earlyHover, false, 'hover before localized tooltip insertion must not expose unmeasured content');
  await page.locator('[data-tab="settings"]').click();
  const help = page.locator('[data-i18n-tooltip="autoExpireHelp"]');
  assert.equal(await help.count(), 1);
  await page.setViewportSize({ width: 350, height: 300 });
  await placeAt(help, 220);
  await help.hover();
  // Hover may scroll the trigger into view; position the bottom-edge fixture afterwards.
  await placeAt(help, 220);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const tooltip = help.locator('.help-pop');
  await tooltip.waitFor({ state: 'visible' });
  const bounds = await tooltip.boundingBox();
  console.log('Auto-clear tooltip:', bounds, 'trigger:', await help.boundingBox());
  assert(bounds.y >= 0 && bounds.y + bounds.height <= 300,
    'Auto-clear help near the bottom must fit the viewport and use free space above');
  assert(bounds.y + bounds.height <= (await help.boundingBox()).y,
    'Auto-clear help must open above when below has insufficient room');

  await page.setViewportSize({ width: 350, height: 600 });
  const output = process.env.XPORTER_APPEARANCE_OUTPUT || '/private/tmp/xporter-appearance-qa';
  fs.mkdirSync(output, { recursive: true });
  const readSettings = () => page.evaluate(async () => (await chrome.storage.local.get('xporter_settings')).xporter_settings);
  await page.locator('#openThemePicker').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('body').getAttribute('data-theme-preset'), 'classic-dark', 'classic theme is the default');
  assert(await page.locator('body').evaluate(e => e.classList.contains('simplified')), 'default appearance must be neutral');
  assert.equal(await page.locator('#uiScale').inputValue(), '100');
  await page.evaluate(async () => {
    const stored = await chrome.storage.local.get('xporter_settings');
    await chrome.storage.local.set({xporter_settings:{...stored.xporter_settings,quantityLimit:777}});
  });
  await page.locator('#openThemePicker').click();
  await page.locator('[data-preset="glass-dark"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-preset="glass-dark"]').disabled);
  await page.keyboard.press('Escape');
  assert.equal((await readSettings()).quantityLimit, 777, 'appearance saves must preserve newer settings from another surface');
  await page.setViewportSize({ width: 403, height: 600 });
  await page.locator('#sizeSettings').evaluate(el => { el.open = true; });
  await page.locator('#uiScale').fill('115');
  await page.locator('#uiScale').dispatchEvent('change');
  await page.waitForFunction(() => document.body.style.getPropertyValue('--ui-scale') === '1.15');
  assert.equal((await readSettings()).uiScale, 115);
  const overlayAppearance = await worker.evaluate(async () => (await getOverlayI18n()).appearance);
  assert.equal(overlayAppearance.theme, 'dark');
  assert.equal(overlayAppearance.uiScale, 115);
  const scaledWidth = (await page.locator('body').boundingBox()).width;
  assert(Math.abs(scaledWidth - 350) < 1, `Element size must preserve the 350px window, got ${scaledWidth}`);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('postSelectionCount').textContent.includes('5'));
  assert.equal(await page.locator('body').getAttribute('data-theme-preset'), 'glass-dark');
  assert.equal(await page.locator('#uiScale').inputValue(), '115');
  console.log('PASS live scale/design changes, reopening and independent settings persistence');

  const languages = process.env.XPORTER_APPEARANCE_LANGUAGES?.split(',') || fs.readdirSync(path.join(root, 'popup/locales')).filter(name => name.endsWith('.json')).map(name => name.slice(0,-5));
  let cases = 0;
  for (const language of languages) for (const theme of ['dark','light']) for (const simplifiedDesign of [false,true]) {
    const scales = [80,85,90,95,100,105,110,115,120,125,130];
    for (const uiScale of scales) {
      const width = 350;
      const tag = `${language}-${theme}-${simplifiedDesign ? 'simple' : 'blue'}-${uiScale}`;
      await page.setViewportSize({width,height:600});
      await page.evaluate(async settings => {
        const stored = await chrome.storage.local.get('xporter_settings');
        await chrome.storage.local.set({xporter_settings:{...stored.xporter_settings,...settings}});
      }, {language,theme,simplifiedDesign,uiScale});
      await page.reload();
      await page.waitForFunction(language => document.documentElement.lang === language && document.getElementById('postSelectionCount').textContent.includes('5'), language);
      assert.equal(await page.locator('.post-type-description').count(), 0, `${tag}: explanations belong only in help`);
      assert.equal(await page.locator('.post-type-help').count(), 5);
      const helpLayout = await page.locator('.post-type-row').evaluateAll(rows => rows.map(row => {
        const info = row.querySelector('.post-type-help').getBoundingClientRect();
        const check = row.querySelector('.post-choice-check').getBoundingClientRect();
        const label = row.querySelector('.post-choice-copy').getBoundingClientRect();
        return { info: info.toJSON(), check: check.toJSON(), label: label.toJSON() };
      }));
      for (const {info, check} of helpLayout) {
        assert(Math.abs(info.width - 16 * uiScale / 100) < 1, `${tag}: help uses the original 16px icon size`);
        assert(language === 'ar' ? info.left >= check.right : info.right <= check.left,
          `${tag}: help must precede the checkbox without overlapping it`);
      }
      assert.equal(await page.locator('.post-type-help .help-pop strong').count(), 5,
        `${tag}: every post type has a highlighted explanation`);
      const fontHeight = await page.locator('.post-choice-copy strong').first().evaluate(el => el.getBoundingClientRect().height);
      assert(fontHeight >= 14, `${tag}: text remains readable independently of controls`);
      for (const testWidth of [width,320]) {
        await page.setViewportSize({width:testWidth,height:600});
        const overflow = await page.evaluate(() => ({
          content: document.documentElement.scrollWidth, viewport: innerWidth,
          outliers:[...document.querySelectorAll('#popup *')].map(el=>({el,r:el.getBoundingClientRect()}))
            .filter(({el,r})=>r.width>1 && (r.left < -1 || r.right > innerWidth+1))
            .slice(0,12).map(({el,r})=>({id:el.id,class:el.className,left:r.left,right:r.right})),
          clipped:[...document.querySelectorAll('#tab-home select, #tab-home button, .post-type-row, .tab')]
            .filter(el=>{const r=el.getBoundingClientRect();return r.width>1 && (r.left < -1 || r.right > innerWidth+1);}).map(el=>el.id || el.className)
        }));
        assert(overflow.content <= testWidth+1, `${tag}/${testWidth}: horizontal overflow ${JSON.stringify(overflow)}`);
        assert.deepEqual(overflow.clipped, [], `${tag}/${testWidth}: clipped controls`);
        const helpButton = page.locator('.post-type-help').last();
        await helpButton.scrollIntoViewIfNeeded();
        const checked = await page.locator('#includeArticles').isChecked();
        await helpButton.click();
        const pop = helpButton.locator('.help-pop');
        assert.equal(await pop.isVisible(), true);
        assert.equal(await page.locator('#includeArticles').isChecked(), checked, 'reading help must never change selection');
        const rect = await pop.boundingBox();
        assert(rect.x >= -1 && rect.x+rect.width <= testWidth+1 && rect.y >= -1 && rect.y+rect.height <=600+1, `${tag}/${testWidth}: help must fit ${JSON.stringify(rect)}`);
        await page.keyboard.press('Escape');
        assert.equal(await pop.isVisible(), false, 'Escape dismisses focused help');
      }
      await page.setViewportSize({width,height:600});
      await page.locator('#tabBtnSettings').click();
      if (language === 'en') {
        for (const localHelp of await page.locator('.help-local').all()) {
          await localHelp.scrollIntoViewIfNeeded();
          await localHelp.focus();
          await page.keyboard.press('Enter');
          const localRect = await localHelp.locator('.help-pop').boundingBox();
          assert(localRect && localRect.x >= -1 && localRect.x + localRect.width <= width + 1,
            `${tag}: legacy local help must use measured viewport positioning`);
          await page.keyboard.press('Escape');
        }
      }
      const autoHelp = page.locator('[data-i18n-tooltip="autoExpireHelp"]');
      await placeAt(autoHelp, 520);
      await autoHelp.focus();
      await page.keyboard.press('Enter');
      await autoHelp.locator('.help-pop').waitFor({state:'visible'});
      const autoRect = await autoHelp.locator('.help-pop').boundingBox();
      assert(autoRect.y >= -1 && autoRect.y+autoRect.height <= 600+1, `${tag}: Auto-clear help must fit at scale`);
      await page.keyboard.press('Escape');
      if (language === 'ru' && [100,130].includes(uiScale)) {
        await page.locator('#openThemePicker').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(output,`settings-${tag}.png`)});
        await page.locator('#tabBtnHome').click();
        await page.locator('#authWarning').evaluate(el=>el.classList.add('hidden'));
        await page.locator('#usernameInput').fill('AteoBreaking');
        await page.evaluate(()=>{ window.scrollTo(0,0); document.getElementById('homeContent').scrollTop=0; });
        await page.screenshot({path:path.join(output,`popup-${tag}.png`)});
      }
      cases++;
    }
  }
  console.log(`PASS ${cases} appearance combinations, ${languages.length} locales, all 4 scales, normal/320px widths, compact rows and adaptive help`);
  assert.deepEqual(errors, []);

  console.log('PASS bottom-edge Auto-clear help');
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
