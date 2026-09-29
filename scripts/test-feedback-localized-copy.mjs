// Local preview only: intercept all requests, never submit real feedback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import toolingPolicy from './tooling-policy.js';
import { inspectCopy } from './lib/inspect-localized-copy.mjs';

toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const locales = (process.env.XPORTER_LOCALES || 'en,ru,de,fr,es,it,pt,tr,ar,hi,ja,ko,zh,id').split(',');
const output = process.env.XPORTER_FEEDBACK_QA_OUTPUT || path.join(os.tmpdir(), 'xporter-feedback-copy-qa');
fs.mkdirSync(output, { recursive: true });
const html = fs.readFileSync('docs/feedback.html', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.XPORTER_BROWSER_EXECUTABLE, headless: true });
const findings = [], checks = [], errors = [], blockedRequests = [];
try {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    await context.route('**/*', route => {
        if (route.request().isNavigationRequest() && new URL(route.request().url()).hostname === 'localhost') {
            return route.fulfill({ contentType: 'text/html', body: html });
        }
        const url = new URL(route.request().url());
        const asset = url.pathname.slice(1);
        if (url.hostname === 'localhost' && ['assets/diagnostics-codec.js', 'assets/feedback-language.js',
            'assets/feedback-receipt.js', 'vendor/canvas-confetti.browser.js'].includes(asset)) {
            return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join('docs',asset),'utf8')});
        }
        blockedRequests.push(route.request().url());
        return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const language of locales) for (const width of [350, 1280]) for (const theme of ['dark', 'light']) {
        const tag = { language, width, theme };
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`http://localhost/feedback.html?preview=1&ui_lang=${language}&theme=${theme}`);
        await page.locator('.reason').first().waitFor();
        async function scan(state, screenshot = false) {
            await page.evaluate(async () => {
                await document.fonts.ready;
                await Promise.all(document.getAnimations().filter(a => a.effect.getComputedTiming().iterations !== Infinity)
                    .map(a => a.finished.catch(() => {})));
            });
            findings.push(...(await page.evaluate(inspectCopy)).map(problem => ({ ...tag, state, ...problem })));
            checks.push({ ...tag, state });
            if (screenshot) await page.screenshot({ path: path.join(output, `${language}-${width}-${theme}-${state}.png`), fullPage: false });
        }
        await scan('reasons', width === 350 && theme === 'dark');
        const reasons = page.locator('.reason');
        for (let index = 0; index < await reasons.count(); index++) {
            await reasons.nth(index).click();
            await scan(`detail-${index}`);
            if (await reasons.nth(index).getAttribute('data-reason') === 'r_missing') {
                await page.locator('[data-subreason="sr_missing_different_format"]').click();
                await page.locator('#formatBlock:not([hidden])').waitFor();
                await page.locator('[data-subreason="sr_missing_format_pdf"]').click();
                await page.locator('[data-subreason="sr_missing_format_html"]').click();
                assert.equal(await page.locator('#formatOptions [aria-pressed="true"]').count(), 2);
                await scan('requested-formats', width === 350 && theme === 'dark');
                // Native button keyboard activation is part of the multiselect contract.
                await page.locator('[data-subreason="sr_missing_format_json"]').focus();
                await page.keyboard.press('Space');
                assert.equal(await page.locator('[data-subreason="sr_missing_format_json"]').getAttribute('aria-pressed'), 'true');
                await page.locator('[data-subreason="sr_missing_different_format"]').click();
                assert(await page.locator('#formatBlock').evaluate(el => el.hidden));
                assert.equal(await page.locator('#formatOptions button').count(), 0);
            }
        }
        await page.locator('#detail').fill('Local layout preview');
        await page.locator('#submitBtn').click();
        await page.locator('#thanks.show').waitFor();
        await scan('thanks', width === 350 && theme === 'dark');
        await page.locator('#backToFeedback').click();
        await scan('returned');
        console.log(`PASS rendering exercised: ${language}/${width}/${theme}`);
    }
} finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, findings, errors, blockedRequests }, null, 2));
}
assert.deepEqual(errors, [], 'feedback runtime errors');
assert.deepEqual(findings, [], 'feedback copy must fit');
console.log(`PASS: ${checks.length} feedback states; no clipped text. ${output}`);
