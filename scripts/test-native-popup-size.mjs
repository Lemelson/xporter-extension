// Exercise the real action window's preferred-size negotiation, not a tab
// whose viewport was pre-sized by Playwright. Uses a disposable Helium profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';
toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import('playwright');
const root = process.env.XPORTER_NATIVE_ROOT || process.cwd();
const helium = '/Applications/Helium.app/Contents/MacOS/Helium';
const executablePath = process.env.XPORTER_BROWSER_EXECUTABLE ||
    (fs.existsSync(helium) ? helium : chromium.executablePath());
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-native-popup-'));
const context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: false,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = context.pages()[0];
    const cdp = await context.newCDPSession(page);
    let nextId = 0;
    const pending = new Map();
    cdp.on('Target.receivedMessageFromTarget', event => {
        const message = JSON.parse(event.message);
        const settle = pending.get(message.id);
        if (settle) { pending.delete(message.id); settle(message); }
    });
    async function evaluate(sessionId, expression) {
        const id = ++nextId;
        let timer;
        const response = new Promise((resolve, reject) => {
            timer = setTimeout(() => { pending.delete(id); reject(new Error("Native popup RPC timed out")); }, 10000);
            pending.set(id, message => { clearTimeout(timer); resolve(message); });
        });
        await cdp.send('Target.sendMessageToTarget', { sessionId,
            message: JSON.stringify({id, method:'Runtime.evaluate',params:{expression,returnByValue:true}}) });
        const result = await response;
        assert(!result.error && !result.result.exceptionDetails, JSON.stringify(result));
        return result.result.result.value;
    }
    for (const simplifiedDesign of [false, true]) for (const theme of ['dark', 'light']) {
        for (const uiScale of [85, 100, 115, 130]) {
            await page.bringToFront();
            await worker.evaluate(async settings => {
                await chrome.storage.local.set({xporter_settings:{...settings,language:'en'}});
                const [window] = await chrome.windows.getAll({windowTypes:['normal']});
                await chrome.windows.update(window.id, {focused:true});
                await chrome.action.openPopup({windowId:window.id});
            }, {simplifiedDesign,theme,uiScale});
            let target;
            for (let attempt=0; attempt<50 && !target; attempt++) {
                target=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/popup/popup.html'));
                if (!target) await new Promise(resolve=>setTimeout(resolve,100));
            }
            assert(target,'native action popup must open');
            const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
            let geometry;
            for (let attempt=0; attempt<50; attempt++) {
                geometry=JSON.parse(await evaluate(sessionId, `JSON.stringify({
                    width:innerWidth, height:innerHeight, scrollWidth:document.documentElement.scrollWidth,
                    bodyWidth:document.body.getBoundingClientRect().width,
                    native:document.documentElement.classList.contains('action-popup'),
                    scale:document.getElementById('uiScale')?.value,
                    tabHeights:[...document.querySelectorAll('.tab')].map(el=>el.getBoundingClientRect().height)
                })`));
                if (geometry.width===4*uiScale && geometry.scale===String(uiScale)) break;
                await new Promise(resolve=>setTimeout(resolve,100));
            }
            assert.equal(geometry.native,true);
            assert.equal(geometry.width,4*uiScale,JSON.stringify({theme,simplifiedDesign,uiScale,...geometry}));
            assert.equal(geometry.bodyWidth,geometry.width);
            assert(geometry.scrollWidth<=geometry.width,'native popup must not overflow horizontally');
            assert(geometry.tabHeights.every(height=>height<80),'tab labels must not become vertical columns');
            console.log(`PASS native ${theme}/${simplifiedDesign?'simple':'blue'}/${uiScale}%: ${geometry.width}×${geometry.height}`);
            await evaluate(sessionId,'setTimeout(()=>window.close(),0); true');
            await new Promise(resolve=>setTimeout(resolve,120));
        }
    }
} finally {
    await context.close();
    fs.rmSync(profile,{recursive:true,force:true});
}
