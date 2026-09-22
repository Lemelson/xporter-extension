// Checks painted coordinates through CDP, independently of getBoundingClientRect's
// changed CSS-zoom semantics in Chrome 128. Run against both old and current Chrome.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';

toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-zoom-'));
const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(),
    // Chrome 127's default old headless mode does not load extensions.
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const browserVersion = (await cdp.send('Browser.getVersion')).product;
    console.log(browserVersion);
    const legacyCoordinates = Number(browserVersion.split('/')[1].split('.')[0]) < 128;
    let cases = 0;
    for (const language of ['en', 'ru']) for (const theme of ['dark', 'light']) {
        for (const simplifiedDesign of [false, true]) for (const uiScale of [85, 100, 115, 130]) {
            const tag = `${language}/${theme}/${simplifiedDesign ? 'simple' : 'blue'}/${uiScale}`;
            const width = Math.round(350 * uiScale / 100);
            await worker.evaluate(async settings => {
                await chrome.storage.local.set({ xporter_settings: settings });
            }, { language, theme, simplifiedDesign, uiScale });
            await page.setViewportSize({ width, height: 600 });
            await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
            await page.waitForFunction(language => document.documentElement.lang === language &&
                document.getElementById('postSelectionCount')?.textContent.includes('5'), language);
            await page.evaluate(() => document.fonts.ready);
            for (const key of ['exportModeHelp', 'postTypeRepliesHelp']) {
                const selector = `[data-i18n-tooltip="${key}"]`;
                const trigger = page.locator(selector);
                await trigger.focus();
                await page.waitForFunction(selector => document.querySelector(selector)
                    .querySelector('.help-pop').matches(':popover-open'), selector);
                const { result } = await cdp.send('Runtime.evaluate', {
                    expression: `document.querySelector(${JSON.stringify(selector)}).querySelector('.help-pop')`
                });
                const { model } = await cdp.send('DOM.getBoxModel', { objectId: result.objectId });
                await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
                // Historical CDP boxes are also in pre-zoom coordinates. The
                // version is an independent test oracle, never used by runtime.
                const painted = model.border.map(value => value * (legacyCoordinates ? uiScale / 100 : 1));
                const x = painted.filter((_, index) => index % 2 === 0);
                const y = painted.filter((_, index) => index % 2 === 1);
                assert(Math.min(...x) >= -1 && Math.max(...x) <= width + 1 &&
                    Math.min(...y) >= -1 && Math.max(...y) <= 601,
                `${tag}/${key}: painted help is outside viewport: ${JSON.stringify(painted)}`);
                await page.keyboard.press('Escape');
                await trigger.blur();
            }
            cases++;
        }
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${cases} zoom/theme/style/locale cases; painted help fits the viewport`);
} finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
}
