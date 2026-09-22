#!/usr/bin/env node
// Narrow/short popup keyboard geometry, using an isolated extension profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';
import { inspectCopy } from './lib/inspect-localized-copy.mjs';

toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-menu-layout-'));
const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(),
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 280, height: 600 });
    const output = process.env.XPORTER_MENU_QA_OUTPUT;
    if (output) fs.mkdirSync(output, { recursive: true });
    let cases = 0;
    for (const language of ['en', 'ar']) for (const uiScale of [80, 100, 130]) {
        for (const popupHeight of [50, 100]) {
            const tag = `${language}/${uiScale}%/height${popupHeight}%`;
            await worker.evaluate(settings => chrome.storage.local.set({ xporter_settings: settings }), {
                language, uiScale, popupHeight, textScale: 130, popupWidth: 80, ladybugEnabled: false
            });
            await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
            await page.waitForFunction(lang => document.documentElement.lang === lang &&
                document.querySelector('#postSelectionCount').textContent.includes('/5'), language);
            await page.evaluate(() => document.fonts.ready);
            await page.locator('#langBtn').focus();
            await page.keyboard.press('ArrowDown');
            const geometry = await page.evaluate(() => ({
                menu: document.querySelector('#langDropdown').getBoundingClientRect().toJSON(),
                shell: document.querySelector('#popup').getBoundingClientRect().toJSON()
            }));
            assert(geometry.menu.left >= geometry.shell.left && geometry.menu.right <= geometry.shell.right,
                `${tag}: menu must fit horizontally: ${JSON.stringify(geometry)}`);
            assert(geometry.menu.bottom <= Math.min(geometry.shell.bottom, 600) + 1,
                `${tag}: menu must fit the reduced shell: ${JSON.stringify(geometry)}`);
            await page.keyboard.press('End');
            if (output && uiScale === 130 && popupHeight === 50) {
                await page.screenshot({ path: path.join(output, `${language}-narrow-language-menu.png`) });
            }
            assert(await page.locator('.lang-option').last().evaluate(el => {
                const rect = el.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
                return document.activeElement === el && !!hit && (hit === el || el.contains(hit));
            }), `${tag}: final language must be visible and keyboard reachable`);
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'langBtn');
            assert.equal(await page.locator('#popup').evaluate(el => el.scrollTop), 0,
                `${tag}: focusing menu items must not scroll hidden shell contents`);
            await page.locator('#tabBtnHome').focus();
            await page.keyboard.press(language === 'ar' ? 'ArrowLeft' : 'ArrowRight');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'tabBtnSettings',
                `${tag}: arrow navigation must follow the physical tab direction`);
            cases++;
        }
    }
    for (const language of ['ru', 'es', 'pt', 'tr']) {
        await worker.evaluate(settings => chrome.storage.local.set({ xporter_settings: settings }), {
            language, uiScale: 130, textScale: 130, popupWidth: 80, popupHeight: 100,
            exportMode: 'verified_followers', ladybugEnabled: false
        });
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
        await page.waitForFunction(lang => document.documentElement.lang === lang &&
            document.querySelector('#exportMode').value === 'verified_followers', language);
        const findings = (await page.evaluate(inspectCopy)).filter(issue => issue.kind === 'select-truncation');
        assert.deepEqual(findings, [], `${language}: long selected mode must fit narrow window with large text`);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${cases} narrow menu/short shell/scale/RTL keyboard cases and 4 long translated mode labels`);
} finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
}
