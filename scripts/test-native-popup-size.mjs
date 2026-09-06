// Real Helium action windows: preferred width, hover stability and bottom scrolling.
// A pre-sized browser tab cannot detect the action window resizing around a tooltip.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';
toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.XPORTER_NATIVE_ROOT || process.cwd();
const baseWidth = Number(process.env.XPORTER_NATIVE_BASE_WIDTH || 350);
const scales = (process.env.XPORTER_NATIVE_SCALES || '85,100,115,130').split(',').map(Number);
const languages = (process.env.XPORTER_NATIVE_LOCALES || 'en').split(',');
const appearances = process.env.XPORTER_NATIVE_CLASSIC_ONLY ? [false] : [false, true];
const helium = '/Applications/Helium.app/Contents/MacOS/Helium';
const executablePath = process.env.XPORTER_BROWSER_EXECUTABLE ||
    (fs.existsSync(helium) ? helium : chromium.executablePath());
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-native-popup-'));
const context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: false, viewport: null,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
const footerProblems = [];
try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const page = context.pages()[0];
    const cdp = await context.newCDPSession(page);
    let nextId = 0;
    const pending = new Map();
    cdp.on('Target.receivedMessageFromTarget', event => {
        const message = JSON.parse(event.message);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
    });
    async function rpc(sessionId, method, params) {
        const id = ++nextId;
        const response = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Native popup ${method} timed out`));
            }, 10000);
            pending.set(id, message => { clearTimeout(timer); resolve(message); });
        });
        await cdp.send('Target.sendMessageToTarget', {
            sessionId, message: JSON.stringify({ id, method, params })
        });
        const result = await response;
        assert(!result.error && !result.result.exceptionDetails, JSON.stringify(result));
        return result.result;
    }
    async function evaluate(sessionId, expression) {
        return (await rpc(sessionId, 'Runtime.evaluate', {
            expression, returnByValue: true, awaitPromise: true
        })).result.value;
    }
    for (const language of languages) for (const simplifiedDesign of appearances) for (const theme of ['dark', 'light']) {
        for (const uiScale of scales) {
            const tag = `${language}/${theme}/${simplifiedDesign ? 'simple' : 'blue'}/${uiScale}%`;
            const expectedWidth = Math.floor(baseWidth * uiScale / 100);
            await page.bringToFront();
            await worker.evaluate(async settings => {
                await chrome.storage.local.set({ xporter_settings: settings });
                const [window] = await chrome.windows.getAll({ windowTypes: ['normal'] });
                // macOS can acknowledge the focus request before the previous
                // action window has finished closing. Retry only that focus race.
                for (let attempt = 0; attempt < 5; attempt++) {
                    await chrome.windows.update(window.id, { focused: true });
                    await new Promise(resolve => setTimeout(resolve, 300));
                    try {
                        await chrome.action.openPopup({ windowId: window.id });
                        break;
                    } catch (error) {
                        if (attempt === 4 || !error.message.includes('inactive window')) throw error;
                    }
                }
            }, { simplifiedDesign, theme, uiScale, language });
            let target;
            for (let attempt = 0; attempt < 50 && !target; attempt++) {
                target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url.endsWith('/popup/popup.html'));
                if (!target) await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert(target, 'native action popup must open');
            const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
            const run = expression => evaluate(sessionId, expression);
            await run(`new Promise((resolve, reject) => {
                const until = performance.now() + 5000;
                function ready() {
                    if (document.getElementById('postSelectionCount')?.textContent.includes('5') &&
                        document.getElementById('uiScale')?.value === '${uiScale}') resolve();
                    else if (performance.now() > until) reject(new Error('Popup did not initialize'));
                    else requestAnimationFrame(ready);
                }
                ready();
            })`);
            const geometry = await run(`({ width: innerWidth, bodyWidth: document.body.getBoundingClientRect().width,
                native: document.documentElement.classList.contains('action-popup') })`);
            assert.equal(geometry.native, true);
            assert.equal(geometry.width, expectedWidth, `${tag}: ${JSON.stringify(geometry)}`);
            assert(Math.abs(geometry.bodyWidth - geometry.width) <= 1);

            async function pointAt(selector) {
                await run(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
                await new Promise(resolve => setTimeout(resolve, 100));
                return run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            }
            async function click(selector) {
                const point = await pointAt(selector);
                await rpc(sessionId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
                await rpc(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            async function startTrace() {
                await run(`window.__popupTrace = []; window.__traceUntil = performance.now() + 350;
                    (function frame() {
                        window.__popupTrace.push({ width: innerWidth, x: screenX, y: scrollY,
                            scrollWidth: document.documentElement.scrollWidth });
                        if (performance.now() < window.__traceUntil) requestAnimationFrame(frame);
                    })()`);
            }
            for (const selector of ['[data-i18n-tooltip="postTypeRepliesHelp"]', '[data-i18n-tooltip="exportModeHelp"]']) {
                const point = await pointAt(selector);
                await startTrace();
                await rpc(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
                await new Promise(resolve => setTimeout(resolve, 400));
                const frames = await run('window.__popupTrace');
                assert(frames.every(f => f.width === expectedWidth && f.scrollWidth <= expectedWidth && f.x === frames[0].x),
                    `${tag} hover ${selector}: action window moved/resized: ${JSON.stringify(frames)}`);
                const help = await run(`document.querySelector(${JSON.stringify(selector)}).querySelector('.help-pop').getBoundingClientRect().toJSON()`);
                assert(help.width > 0 && help.left >= 0 && help.right <= expectedWidth + 1 && help.top >= 0 && help.bottom <= 601,
                    `${tag}: help must fit the actual action window: ${JSON.stringify(help)}`);
                await rpc(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
                await new Promise(resolve => setTimeout(resolve, 180));
            }
            await click('#tabBtnAbout');
            await run('window.scrollTo(0, document.documentElement.scrollHeight)');
            await new Promise(resolve => setTimeout(resolve, 200));
            await startTrace();
            await rpc(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: expectedWidth / 2, y: 500, deltaX: 0, deltaY: 800 });
            await new Promise(resolve => setTimeout(resolve, 400));
            const footer = await run("document.querySelector('.footer').getBoundingClientRect().toJSON()");
            const frames = await run('window.__popupTrace');
            if (footer.bottom > 601) footerProblems.push({ tag, footer });
            assert(frames.every((f, i) => !i || f.y >= frames[i - 1].y - 1), `${tag}: downward wheel must not move content back up`);
            console.log(`${footer.bottom <= 601 ? 'PASS' : 'FAIL footer'} native ${tag}: ${geometry.width}px, stationary hover and reachable About footer`);
            await run('setTimeout(() => window.close(), 0); true');
            await new Promise(resolve => setTimeout(resolve, 120));
        }
    }
    assert.deepEqual(footerProblems, [], 'All native popup footers must be reachable');
} finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
}
