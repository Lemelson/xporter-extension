#!/usr/bin/env node
// Real extension rendering in an isolated browser profile. No live export is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';
import { inspectCopy } from './lib/inspect-localized-copy.mjs';

toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const locales = (process.env.XPORTER_LOCALES || 'en,ru,de,fr,es,it,pt,tr,ar,hi,ja,ko,zh,id').split(',');
const output = process.env.XPORTER_COPY_QA_OUTPUT || path.join(os.tmpdir(), 'xporter-copy-qa');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-copy-browser-'));
const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(),
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
const findings = [];
const checks = [];
const errors = [];


try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 350, height: 600 });
    const url = `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;
    let tag;
    async function scan(state, screenshot = false) {
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(60);
        findings.push(...(await page.evaluate(inspectCopy)).map(problem => ({ ...tag, state, ...problem })));
        checks.push({ ...tag, state });
        if (screenshot) {
            await page.screenshot({ path: path.join(output, `${tag.language}-${tag.theme}-${state}.png`), fullPage: true });
        }
    }
    async function configure(settings) {
        await worker.evaluate(async settings => {
            currentExport = null;
            const stored = await chrome.storage.local.get('xporter_settings');
            await chrome.storage.local.set({ xporter_settings: { ...stored.xporter_settings,
                uiScale: 100, simplifiedDesign: false, ...settings } });
        }, settings);
        await page.goto(url);
        await page.waitForFunction(language => document.documentElement.lang === language &&
            document.getElementById('uiScale').value === '100', settings.language);
        await page.waitForFunction(() => document.getElementById('postSelectionCount').textContent.includes('/5'));
    }
    async function scanHelp() {
        const helpers = page.locator('[data-i18n-tooltip]');
        for (let index = 0; index < await helpers.count(); index++) {
            const helper = helpers.nth(index);
            if (!await helper.isVisible()) continue;
            await helper.scrollIntoViewIfNeeded();
            await helper.focus();
            await page.keyboard.press('Enter');
            const pop = helper.locator('.help-pop');
            if (await pop.isVisible()) {
                const key = await helper.getAttribute('data-i18n-tooltip');
                const rect = await pop.boundingBox();
                if (rect.x < -1 || rect.x + rect.width > 351 || rect.y < -1 || rect.y + rect.height > 601) {
                    findings.push({ ...tag, state: `help:${key}`, kind: 'help-outside-window', rect });
                }
                // Scan after internal scrolling as well: long explanations must remain reachable.
                await scan(`help:${key}`);
                await pop.evaluate(el => { el.scrollTop = el.scrollHeight; });
                await scan(`help-end:${key}`);
            }
            await page.keyboard.press('Escape');
            await helper.blur();
        }
    }
    for (const language of locales) {
        const translations = JSON.parse(fs.readFileSync(path.join(root, `popup/locales/${language}.json`)));
        for (const theme of ['dark', 'light']) {
            tag = { language, theme, scale: 100 };
            await configure({ language, theme, exportMode: 'posts', outputFormat: 'xlsx',
                quantityLimit: 0, exportSpeed: 'custom', userExportSpeed: 'custom',
                postSafetyBreakEnabled: true, userSafetyBreakEnabled: true,
                includeAboutAccountDetails: false });
            await scan('home', theme === 'dark');
            assert.equal(await page.locator('#quantityLimit option[value="0"]').textContent(), translations.unlimited);
            await page.locator('label:has(#dateCheck)').click();
            assert.equal(await page.locator('#quantityLimit option[value="0"]').textContent(), translations.noCustomLimit);
            await scan('dates');
            if (theme === 'dark' && !process.env.XPORTER_COPY_FAST) await scanHelp();
            await page.locator('#tabBtnSettings').click();
            await scan('settings-posts', theme === 'dark');
            if (theme === 'dark' && !process.env.XPORTER_COPY_FAST) await scanHelp();
            await page.locator('#historyToggle').click();
            await page.locator('#feedDbToggle').click();
            await scan('history-collection');
            await page.locator('#tabBtnAbout').click();
            await page.locator('.detail-item').evaluateAll(async elements => {
                elements.forEach(el => el.classList.add('open'));
                elements.forEach(el => el.getBoundingClientRect());
                await Promise.all(elements.flatMap(el => el.getAnimations({ subtree: true }))
                    .filter(animation => animation.effect.getComputedTiming().iterations !== Infinity)
                    .map(animation => animation.finished.catch(() => {})));
            });
            await scan('about', theme === 'dark');
            await page.locator('#rateAboutBtn').click();
            await scan('rate-dialog');
            await page.keyboard.press('Escape');
            // Reopen with each mode; settings also contain conditional bookmark/user controls.
            for (const mode of ['bookmarks', 'verified_followers']) {
                await configure({ language, theme, exportMode: mode, includeAboutAccountDetails: false });
                assert.equal(await page.locator('#quantityLimit option[value="0"]').textContent(), translations.noCustomLimit);
                await scan(`home-${mode}`);
                await page.locator('#tabBtnSettings').click();
                await scan(`settings-${mode}`, theme === 'dark' && mode === 'bookmarks');
                if (theme === 'dark' && !process.env.XPORTER_COPY_FAST) await scanHelp();
                if (mode === 'verified_followers') {
                    await page.locator('label:has(#includeAboutAccountDetails)').click();
                    await page.locator('#aboutRiskDialog').waitFor({ state: 'visible' });
                    await scan('about-risk-dialog', theme === 'dark');
                    await page.locator('#aboutRiskCancel').click();
                    await configure({ language, theme, exportMode: mode,
                        includeAboutAccountDetails: true, aboutAccountSpeed: 'custom' });
                    await page.locator('#tabBtnSettings').click();
                    await scan('settings-about-details', theme === 'dark');
                    if (theme === 'dark' && !process.env.XPORTER_COPY_FAST) await scanHelp();
                    await page.locator('#aboutAccountMaxRetries').fill('120');
                    await page.locator('#aboutAccountMaxRetries').blur();
                    await page.locator('#aboutRiskDialog').waitFor({ state: 'visible' });
                    await scan('retry-risk-dialog');
                    await page.locator('#aboutRiskCancel').click();
                }
            }
            await configure({ language, theme, exportMode: 'posts', outputFormat: 'xlsx', embedPostPhotos: false });
            await page.locator('label:has(#xlsxPhotoEmbed)').click();
            if (await page.locator('#photoPermissionDialog').isVisible()) {
                await scan('photo-permission-dialog', theme === 'dark');
                await page.locator('#photoPermissionCancel').click();
            }
            // Exercise the production status renderer using synthetic state, never START_EXPORT.
            for (const state of [
                { status: 'fetching', running: true },
                { status: 'rate_limited', running: true, until: Date.now() + 60000 },
                { status: 'cooldown', kind: 'batch', running: true, until: Date.now() + 60000 },
                { status: 'stopped', running: false, canResume: true, outputFormat: 'txt' },
                { status: 'error', error: 'REPLIES_UNAVAILABLE', running: false, canResume: true },
                { status: 'error', error: 'SEARCH_END_UNCONFIRMED', running: false, canResume: true },
                { status: 'fetching', exportMode: 'verified_followers', running: true },
                { status: 'stopped', exportMode: 'verified_followers', running: false, canResume: true },
                { status: 'error', error: 'MESSAGING_ERROR', running: false, tweetCount: 0 },
                { status: 'error', error: 'NO_EXPORT_TO_RESUME', running: false, tweetCount: 0 }
            ]) {
                await worker.evaluate(async state => {
                    const payload = { type: 'EXPORT_STATUS_UPDATE', username: 'example', exportMode: 'posts',
                        tweetCount: 1000000, quantityLimit: 0, outputFormat: 'xlsx', ...state };
                    currentExport = { ...payload, settings: { quantityLimit: 0 }, startedAt: Date.now() };
                    await chrome.runtime.sendMessage(payload);
                }, state);
                await scan(`status-${state.status}-${state.error || state.kind || ''}`);
            }
            console.log(`PASS rendering exercised: ${language}/${theme}/100%`);
        }
    }
    assert.deepEqual(errors, [], 'popup runtime errors');
} finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, findings, errors }, null, 2));
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
}
console.log(`${checks.length} rendered states; ${findings.length} layout findings; results: ${output}`);
assert.equal(findings.length, 0, 'localized text must fit without clipping or select truncation');
