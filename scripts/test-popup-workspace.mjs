// Browser proof for the popup's independent scroller and persistent action area.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';
toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.XPORTER_WORKSPACE_ROOT || process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-workspace-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(),
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const url = `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;
  const languages = process.env.XPORTER_WORKSPACE_LANGUAGES?.split(',') ||
    fs.readdirSync(path.join(root, 'popup/locales')).map(name => name.replace('.json', ''));
  let cases = 0;

  const layout = () => page.evaluate(() => {
    const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return { content: rect('#homeContent') || rect('#tab-home'), actions: rect('#tab-home > .actions'),
      footer: rect('.footer'), header: rect('.header'), shell: rect('#popup'), width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth };
  });
  const settledLayout = async () => {
    // Fonts and the Home ResizeObserver can change intrinsic shell height.
    await page.evaluate(async () => {
      await document.fonts.ready;
      let previous = '', stableFrames = 0;
      for (let i = 0; i < 60 && stableFrames < 4; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const shell = document.getElementById('popup').getBoundingClientRect();
        const actions = document.querySelector('#tab-home > .actions').getBoundingClientRect();
        const current = `${shell.height}/${actions.top}/${actions.height}`;
        stableFrames = current === previous ? stableFrames + 1 : 0;
        previous = current;
      }
      if (stableFrames < 4) throw new Error('Home layout did not settle');
    });
    return layout();
  };
  const assertExposed = async (locator, tag) => {
    await locator.scrollIntoViewIfNeeded();
    const exposed = await locator.evaluate(el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit === el || el.contains(hit);
    });
    assert(exposed, `${tag}: control must receive pointer events above action/footer chrome`);
  };

  for (const language of languages) for (const theme of ['dark', 'light']) {
    for (const simplifiedDesign of [false, true]) for (const uiScale of [85, 100, 115, 130]) {
      const tag = `${language}/${theme}/${simplifiedDesign ? 'simple' : 'standard'}/${uiScale}`;
      await worker.evaluate(async settings => chrome.storage.local.set({ xporter_settings: settings }),
        { language, theme, simplifiedDesign, uiScale, textScale: Number(process.env.XPORTER_WORKSPACE_TEXT_SCALE || 100), exportMode: 'posts', outputFormat: 'csv', ladybugEnabled: false });
      await page.setViewportSize({ width: Math.round(350 * uiScale / 100), height: 600 });
      await page.goto(url);
      await page.waitForFunction(lang => document.documentElement.lang === lang &&
        document.getElementById('postSelectionCount').textContent.includes('5'), language);
      const initial = await settledLayout();
      assert(initial.content.bottom <= initial.actions.top + 1,
        `${tag}: export action must not cover scrollable form content: ${JSON.stringify(initial)}`);
      assert.equal(initial.footer.height, 0, `${tag}: Home must hide footer metadata`);
      assert(Math.abs(initial.actions.bottom - initial.shell.bottom) < 1, `${tag}: fixed action must end at the bottom of Home`);
      assert(initial.shell.bottom <= initial.height + 1, `${tag}: complete popup shell fits`);
      assert(initial.scrollWidth <= initial.width + 1, `${tag}: no document horizontal overflow`);
      assert(await page.locator('#signInBtn').isVisible(), `${tag}: sign-in is the primary action without an X session`);
      assert(!await page.locator('#startBtn').isVisible(), `${tag}: no misleading export action before sign-in`);
      assert.equal(await page.locator('#signInBtn').getAttribute('href'), 'https://x.com/login');

      // Render the signed-in state without touching a real account or starting exports.
      await page.locator('#authWarning').evaluate(el => el.classList.add('hidden'));
      assert(await page.locator('#startBtn').isVisible(), `${tag}: signed-in form offers export`);
      assert(!await page.locator('#signInBtn').isVisible(), `${tag}: no redundant login action`);
      const signedIn = await settledLayout();
      const article = page.locator('label:has(#includeArticles)');
      await assertExposed(article, tag);
      const scrolled = await layout();
      assert.equal(scrolled.header.top, signedIn.header.top, `${tag}: scrolling does not move navigation`);
      assert.equal(scrolled.actions.top, signedIn.actions.top, `${tag}: scrolling does not move the action`);
      await article.click();
      assert(!await page.locator('#includeArticles').isChecked(), `${tag}: last row can be toggled`);
      await article.click();
      assert(await page.locator('#includeArticles').isChecked(), `${tag}: last row can be restored`);

      const help = page.locator('.post-type-help').last();
      await help.focus();
      await page.keyboard.press('Enter');
      const helpBox = await help.locator('.help-pop').boundingBox();
      assert(helpBox && helpBox.x >= -1 && helpBox.x + helpBox.width <= initial.width + 1 &&
        helpBox.y >= -1 && helpBox.y + helpBox.height <= 601, `${tag}: help escapes scroller clipping and fits viewport`);
      await page.keyboard.press('Escape');

      if (['en', 'ru', 'ar'].includes(language) && uiScale === 100) {
        for (const mode of ['followers', 'following', 'verified_followers', 'bookmarks', 'posts']) {
          await page.locator('#exportMode').selectOption(mode);
          await assertExposed(page.locator('#startBtn'), `${tag}/${mode}`);
          assert.equal(await page.locator('#usernameField').isVisible(), mode !== 'bookmarks');
        }
        await page.locator('label:has(#dateCheck)').click();
        await assertExposed(page.locator('#dateTo'), tag);
        await page.locator('label:has(#dateCheck)').click();
        await page.locator('#outputFormat').selectOption('xlsx');
        await assertExposed(page.locator('.xlsx-photo-choice').last(), tag);
        await page.locator('#outputFormat').selectOption('csv');
        await page.locator('#tabBtnSettings').click();
        await assertExposed(page.locator('#feedDbToggle'), tag);
        await page.locator('#tabBtnAbout').click();
        const lastDetail = page.locator('.detail-head').last();
        await assertExposed(lastDetail, tag);
        await lastDetail.click();
        assert.equal(await lastDetail.getAttribute('aria-expanded'), 'true');
        await page.setViewportSize({ width: 320, height: 400 });
        await assertExposed(page.locator('.about-source'), tag);
        assert((await layout()).shell.bottom <= 401, `${tag}: shorter preview viewport fits`);
        await page.locator('#langBtn').click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        await assertExposed(page.locator('.lang-option').last(), tag);
        assert((await layout()).shell.bottom <= 401, `${tag}: language menu must scroll without growing the popup`);
        await page.keyboard.press('Escape');
      }
      cases++;
    }
    console.log(`PASS ${language}/${theme}: all scales, both appearances, independent scrolling and focus`);
  }
  assert.deepEqual(errors, [], 'No popup runtime errors');
  console.log(`PASS ${cases} workspace combinations; actions, selection, all export modes, dates, XLSX options, Settings and About`);
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
