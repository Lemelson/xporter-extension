// Run outside CODEX_SANDBOX, in a disposable extension profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./tooling-policy.js').assertBrowserSmokeCanLaunch();
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-review-delay-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.setViewportSize({ width: 350, height: 600 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const url = `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;
    for (const [index, route] of ['later', 'close', 'escape', 'backdrop'].entries()) {
      const language = index % 2 ? 'ru' : 'en';
      const translations = JSON.parse(fs.readFileSync(path.join(root, `popup/locales/${language}.json`)));
      await worker.evaluate(language => chrome.storage.local.set({
        xporter_settings: { language, theme: 'dark', ladybugEnabled: false }
      }), language);
      await page.goto(url);
      await page.waitForFunction(l => document.documentElement.lang === l &&
        document.getElementById('postSelectionCount')?.textContent.includes('5'), language);
      await page.evaluate(async translations => {
        await chrome.storage.local.set({ xporter_rate_prompt: { status: 'pending', exports: 5, deferCount: 0 } });
        await window.XPorterRatePrompt.show({ translations });
      }, translations);
      assert(await page.locator('.xrp-later').isDisabled(), 'Skip must start disabled');
      assert(await page.locator('.xrp-close').isDisabled(), 'Close must start disabled');
      assert((await page.locator('.xrp-later').textContent()).includes('5'), 'Initial countdown is five seconds');
      // Synthetic events also exercise the shared dismissal guard, beyond disabled UI.
      await page.locator('.xrp-later').dispatchEvent('click');
      await page.locator('.xrp-close').dispatchEvent('click');
      await page.keyboard.press('Escape');
      await page.mouse.click(2, 2);
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.xrp-overlay').count(), 1, 'Every early dismissal must be blocked');
      await page.locator('.xrp-rate').focus();
      await page.keyboard.press('Tab');
      assert(await page.locator('.xrp-rate').evaluate(e => e === document.activeElement), 'Tab skips locked controls');
      await page.waitForTimeout(3700);
      assert(await page.locator('.xrp-later').isDisabled(), 'Four seconds is not enough');
      await page.waitForFunction(() => !document.querySelector('.xrp-later').disabled);
      assert.equal(await page.locator('.xrp-later').textContent(), translations.rateLater);
      assert(!await page.locator('.xrp-close').isDisabled());
      if (route === 'later') await page.locator('.xrp-later').click();
      if (route === 'close') await page.locator('.xrp-close').click();
      if (route === 'escape') await page.keyboard.press('Escape');
      if (route === 'backdrop') await page.mouse.click(2, 2);
      await page.locator('.xrp-overlay').waitFor({ state: 'detached' });
      const state = await worker.evaluate(async () => (await chrome.storage.local.get('xporter_rate_prompt')).xporter_rate_prompt);
      assert.equal(state.deferCount, 1, 'Showing and dismissing consume only one prompt');
      console.log(`PASS ${language}/${route}: blocked before five seconds, available afterward`);
    }
    for (const kind of ['photo', 'account', 'retries']) {
      const photo = kind === 'photo';
      await worker.evaluate(({ photo, kind }) => chrome.storage.local.set({
        xporter_settings: { language: 'en', theme: 'dark', ladybugEnabled: false,
          exportMode: photo ? 'posts' : 'verified_followers', outputFormat: photo ? 'xlsx' : 'csv',
          embedPostPhotos: false, includeAboutAccountDetails: kind === 'retries',
          aboutAccountSpeed: 'custom', aboutAccountMaxRetries: 5 },
        xporter_photo_permission_intro_seen: false
      }), { photo, kind });
      await page.goto(url);
      await page.waitForFunction(() => document.getElementById('postSelectionCount')?.textContent.includes('5'));
      if (photo) await page.locator('label:has(#xlsxPhotoEmbed)').click();
      else {
        await page.locator('#tabBtnSettings').click();
        if (kind === 'account') await page.locator('label:has(#includeAboutAccountDetails)').click();
        else {
          await page.locator('#aboutAccountMaxRetries').fill('120');
          await page.locator('#aboutAccountMaxRetries').blur();
        }
      }
      const prefix = photo ? '#photoPermission' : '#aboutRisk';
      const dialog = page.locator(prefix + 'Dialog');
      const cancel = page.locator(prefix + 'Cancel');
      const confirm = page.locator(prefix + 'Confirm');
      await dialog.waitFor({ state: 'visible' });
      assert(await cancel.isDisabled(), kind + ': cancellation starts locked');
      assert(await confirm.isDisabled(), kind + ': confirmation starts locked');
      assert((await confirm.textContent()).includes('5'), kind + ': five-second countdown');
      await cancel.dispatchEvent('click');
      await confirm.dispatchEvent('click');
      await page.keyboard.press('Escape');
      await dialog.dispatchEvent('click');
      await page.mouse.click(2, 2);
      await page.waitForTimeout(400);
      assert(await dialog.isVisible(), kind + ': early click, Escape and backdrop cannot dismiss');
      await page.keyboard.press('Tab');
      assert(await dialog.evaluate(e => e === document.activeElement), kind + ': focus stays in locked dialog');
      await page.waitForTimeout(3700);
      assert(await cancel.isDisabled(), kind + ': still locked at four seconds');
      await page.waitForFunction(selector => !document.querySelector(selector).disabled, prefix + 'Cancel');
      assert(!await confirm.isDisabled(), kind + ': both buttons unlock');
      if (kind === 'account') await page.keyboard.press('Escape');
      else await cancel.click();
      await dialog.waitFor({ state: 'hidden' });
      assert(await page.locator('#popup').evaluate(e => !e.inert), kind + ': popup restored');
      console.log(`PASS ${kind}: Cancel, confirm, Escape and backdrop blocked for five seconds`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
