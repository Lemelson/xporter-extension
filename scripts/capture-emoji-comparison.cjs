// Screenshots of real UI in a disposable profile. Windows emoji mode is simulated on macOS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
require('./tooling-policy.js').assertBrowserSmokeCanLaunch();
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const out = path.resolve(root, '../outputs/emoji-selected');
fs.mkdirSync(out, {recursive: true});
const entries = JSON.parse(fs.readFileSync(path.join(root, 'popup/emoji/manifest.json'))).emoji;
const shots = [
  ['01-open', 'Открытие расширения'], ['02-languages-top', 'Языки — верх списка'],
  ['03-languages-bottom', 'Языки — низ списка'], ['04-help', 'Подсказка режимов экспорта'],
  ['05-ultra', 'Предупреждение в скорости Ultra'], ['06-turbo', 'Предупреждение в скорости Turbo'],
  ['07-warning', 'Диалог включения дополнительных данных'], ['08-chinese', 'Китайский язык'],
  ['09-feedback', 'Страница обратной связи — язык'], ['10-feedback-menu', 'Страница обратной связи — меню'],
  ['11-website', 'Пример на сайте'], ['12-all', 'Все 20 emoji, включая резервный глобус']
];
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const prefix = pathname.startsWith('/site/') ? '/site/' : '/gallery/';
  const base = prefix === '/site/' ? path.join(root, 'docs') : out;
  const file = path.resolve(base, pathname.slice(prefix.length) || 'index.html');
  if (!file.startsWith(base + path.sep)) {res.writeHead(403).end();return;}
  const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2','.svg':'image/svg+xml'};
  try { res.setHeader('Content-Type',types[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file)); }
  catch { res.writeHead(404).end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync('/private/tmp/xporter-emoji-capture-');
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(), headless:true, deviceScaleFactor:2,
    args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]
  });
  const evidence = [];
  try {
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionUrl = `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;
    for (const mode of ['apple','bundled']) {
      await worker.evaluate(() => chrome.storage.local.set({xporter_settings:{language:'en',theme:'dark',themePreset:'signal',exportMode:'tweets',uiScale:100,textScale:100,popupWidth:100,popupHeight:100,ladybugEnabled:false,includeAboutAccountDetails:false}}));
      const page = await context.newPage();
      if (mode === 'bundled') await page.addInitScript(() => {
        Object.defineProperty(navigator,'platform',{get:()=> 'Win32'});
        Object.defineProperty(navigator,'userAgentData',{get:()=>({platform:'Windows'})});
      });
      await page.setViewportSize({width:350,height:600});
      await page.goto(extensionUrl);
      await page.waitForFunction(() => document.querySelector('#postSelectionCount').textContent.includes('5'));
      assert.equal(await page.evaluate(()=>document.documentElement.dataset.emojiPlatform),mode);
      const cdp = await context.newCDPSession(page);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      async function record(selector, label) {
        await page.evaluate(() => document.fonts.ready);
        const {root:doc} = await cdp.send('DOM.getDocument');
        const {nodeId} = await cdp.send('DOM.querySelector',{nodeId:doc.nodeId,selector});
        const {fonts} = await cdp.send('CSS.getPlatformFontsForNode',{nodeId});
        assert(fonts.some(f=>mode==='bundled' ? f.familyName==='XPorter UI Emoji' && f.isCustomFont : f.familyName==='Apple Color Emoji' && !f.isCustomFont),`${mode}/${label}: correct emoji font`);
        evidence.push({mode,label,fonts});
      }
      async function capture(id, selector) {
        await page.evaluate(()=>document.fonts.ready);
        await page.waitForTimeout(120);
        const options = {path:path.join(out,`${id}-${mode}.png`),animations:'disabled'};
        if (selector) await page.locator(selector).screenshot(options);
        else await page.screenshot(options);
      }
      await record('#langFlag','header');
      await capture('01-open');
      await page.locator('#langBtn').click();
      await capture('02-languages-top');
      await page.locator('#langDropdown').evaluate(el=>el.scrollTop=el.scrollHeight);
      await capture('03-languages-bottom');
      await page.locator('#langBtn').click();
      await page.locator('[data-i18n-tooltip="exportModeHelp"]').hover();
      await page.waitForTimeout(250);
      await record('[data-i18n-tooltip="exportModeHelp"] .help-pop','help');
      await capture('04-help');
      await page.keyboard.press('Escape');
      await page.mouse.move(5,5);
      await page.locator('#tabBtnSettings').click();
      for (const [speed,id] of [['ultra','05-ultra'],['turbo','06-turbo']]) {
        await page.locator('#exportSpeed').selectOption(speed);
        await page.locator('#exportSpeed').scrollIntoViewIfNeeded();
        await record('#exportSpeed','speed-'+speed);
        await capture(id);
      }
      await page.locator('label').filter({has:page.locator('#includeAboutAccountDetails')}).click();
      await page.locator('#aboutRiskDialog').waitFor({state:'visible'});
      await page.waitForTimeout(5500);
      await record('#aboutRiskDialog .risk-dialog-icon','warning');
      await capture('07-warning');
      await page.locator('#aboutRiskCancel').click();
      await page.locator('#tabBtnHome').click();
      await page.locator('#langBtn').click();
      await page.locator('.lang-option').filter({hasText:'中文'}).click();
      await page.waitForFunction(()=>document.querySelector('#langCode').textContent==='ZH');
      await capture('08-chinese');
      // Catalogue supplements actual UI: also includes the globe used only as a fallback.
      await page.evaluate(entries => {
        document.body.innerHTML='';
        document.body.style.cssText='width:350px;min-height:600px;background:#181c20!important;color:#fff;padding:16px;box-sizing:border-box;';
        const grid=document.createElement('div');
        grid.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:12px;';
        for(const {emoji} of entries){
          const cell=document.createElement('div');cell.style.cssText='background:#252b32;border-radius:8px;padding:10px;display:flex;align-items:center;gap:12px;';
          const glyph=document.createElement('span');glyph.className='lang-option-flag';glyph.style.fontSize='24px';glyph.textContent=emoji;
          const code=document.createElement('span');code.style.cssText='font:10px ui-monospace,monospace;color:#c2c7cc;';code.textContent=[...emoji].filter(c=>c.codePointAt(0)!==0xfe0f).map(c=>c.codePointAt(0).toString(16)).join(' ');
          cell.append(glyph,code);grid.append(cell);
        }
        document.body.append(grid);
      },entries);
      await capture('12-all');
      await page.setViewportSize({width:560,height:680});
      await page.goto(`${base}/site/feedback.html?lang=en`);
      await page.waitForFunction(()=>document.querySelector('#langCurrentFlag').textContent.includes('🇺🇸'));
      await record('#langCurrentFlag','feedback-header');
      await capture('09-feedback');
      await page.locator('#langBtn').click();
      await capture('10-feedback-menu');
      await page.setViewportSize({width:1280,height:850});
      await page.goto(`${base}/site/index.html`);
      await page.locator('.mock').scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      await record('.emoji-copy','website');
      await capture('11-website','.mock');
      await page.close();
    }
    const html=`<!doctype html><meta charset="utf-8"><title>XPorter — Apple / выбранный набор</title>
<style>body{margin:0;padding:24px;background:#eef0f3;color:#20242b;font:15px system-ui,sans-serif}h1{font-size:26px;margin:0 0 8px}p{max-width:730px;line-height:1.5}.pair{width:740px;box-sizing:border-box;margin:24px 0;padding:16px;background:white;border:1px solid #dde1e7;border-radius:14px;break-inside:avoid}h2{font-size:19px;margin:0 0 12px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}.label{font-size:14px;font-weight:650;margin-bottom:8px}.hint{font-size:11px;font-weight:400;color:#6b7280;margin-top:3px}img{display:block;width:100%;height:auto;border-radius:4px}a{color:inherit;text-decoration:none}</style>
<h1>Apple / выбранный набор — XPorter</h1><p>Слева — родные Apple emoji на macOS. Справа — те же экраны с выбранным набором: режим Windows/Linux принудительно включён на Mac. Это сравнение emoji, не снимки настоящей Windows. Интерфейс открыт в отдельном тестовом профиле без авторизации в X.</p>
${shots.map(([id,title])=>`<section class="pair" id="${id}"><h2>${title}</h2><div class="cols">${['apple','bundled'].map(mode=>`<div><div class="label">${mode==='apple'?'macOS · Apple':'Windows/Linux · выбранный набор'}<div class="hint">${mode==='apple'?'Системные emoji':'Предпросмотр на macOS'}</div></div><a href="${id}-${mode}.png"><img src="${id}-${mode}.png"></a></div>`).join('')}</div></section>`).join('')}`;
    fs.writeFileSync(path.join(out,'index.html'),html);
    fs.writeFileSync(path.join(out,'font-evidence.json'),JSON.stringify(evidence,null,2));
    const gallery=await context.newPage();await gallery.setViewportSize({width:800,height:1000});
    await gallery.goto(`${base}/gallery/index.html`);
    await gallery.evaluate(()=>Promise.all([...document.images].map(img=>img.decode())));
    for(const [id]of shots) await gallery.locator(`[id="${id}"]`).screenshot({path:path.join(out,`${id}-comparison.png`)});
    console.log(`PASS: ${shots.length*2} UI/catalogue screenshots, ${shots.length} comparisons, ${evidence.length} real font checks. ${out}/index.html`);
  } finally {await context.close(); fs.rmSync(profile,{recursive:true,force:true});server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
