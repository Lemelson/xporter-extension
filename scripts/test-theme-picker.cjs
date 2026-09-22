const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./tooling-policy.js').assertBrowserSmokeCanLaunch();
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/lemelson/node_modules/playwright');
const root = process.cwd();
const out = process.env.XPORTER_THEME_SHOTS || '/Users/lemelson/X_stats/design-previews/xporter-theme-picker-2026-09-09';
(async () => {
 const profile = fs.mkdtempSync('/private/tmp/xporter-theme-picker-');
 const context = await chromium.launchPersistentContext(profile, { executablePath: chromium.executablePath(), headless: true,
  deviceScaleFactor: 2, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
 try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 350, height: 600 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await worker.evaluate(() => chrome.storage.local.set({xporter_settings:{language:'en',theme:'dark',quantityLimit:137,outputFormat:'xlsx',ladybugEnabled:false}}));
  const url = `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#postSelectionCount').textContent.includes('5'));
  await page.locator('#authWarning').evaluate(e => e.classList.add('hidden'));
  await page.locator('#usernameInput').fill('example');
  await page.locator('#themeToggle').click();
  assert.equal(await page.locator('.theme-card').count(), 11);
  assert.equal(await page.locator('#themePicker').evaluate(e => e.open), true);
  await page.screenshot({path:path.join(out,'picker-dark-en.png')});
  const ids = await page.locator('.theme-card').evaluateAll(es=>es.map(e=>e.dataset.preset));
  for(const id of ids) {
   await page.locator(`[data-preset="${id}"]`).click();
   await page.waitForFunction(id=>document.body.dataset.themePreset===id && !document.querySelector(`[data-preset="${id}"]`).disabled,id);
   assert.equal(await page.locator('[aria-pressed="true"]').count(),1);
   await page.waitForFunction(()=>!document.querySelector('#themePicker').open);
   assert.equal(await page.locator('#themeToggle').evaluate(e=>e===document.activeElement),true);
   await page.mouse.move(0,0);
   await page.evaluate(()=>document.activeElement?.blur());
   await page.locator('#popup').screenshot({path:path.join(out,id+'.png')});
   if(id==='cobalt') {
    const colors=await page.locator('#startBtn').evaluate(e=>({bg:getComputedStyle(e).backgroundColor,text:getComputedStyle(e).color}));
    assert.equal(colors.bg,'rgb(255, 255, 255)');assert.equal(colors.text,'rgb(16, 16, 16)');
   }
   await page.locator('#tabBtnSettings').click();
   await page.locator('#sizeSettings').evaluate(e=>e.open=true);
   await page.locator('#tab-settings').evaluate(e=>e.scrollTop=0);
   await page.mouse.move(0,0);
   const switches=await page.locator('.toggle-track').evaluateAll(es=>es.map(e=>getComputedStyle(e).backgroundImage));
   assert(switches.every(value=>value==='none'),'switches must use the theme palette');
   await page.locator('#popup').screenshot({path:path.join(out,id+'-settings.png')});
   if(id==='cobalt') assert.equal(await page.locator('#diagnosticsSettings .toggle-label').evaluate(e=>getComputedStyle(e).color),'rgb(16, 29, 57)');
   await page.locator('#diagnosticsSettings').scrollIntoViewIfNeeded();
   await page.screenshot({path:path.join(out,id+'-diagnostics.png')});
   await page.locator('#tabBtnHome').click();
   await page.locator('#themeToggle').click();
  }
  let settings=await worker.evaluate(async()=> (await chrome.storage.local.get('xporter_settings')).xporter_settings);
  assert.equal(settings.quantityLimit,137);assert.equal(settings.outputFormat,'xlsx');
  await page.locator('[data-preset="cobalt"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-preset="cobalt"]').disabled);
  await page.keyboard.press('Escape');await page.reload();
  await page.waitForFunction(()=>document.querySelector('#postSelectionCount').textContent.includes('5'));
  assert.equal(await page.locator('body').getAttribute('data-theme-preset'),'cobalt');
  assert(await page.locator('body').evaluate(e=>e.classList.contains('light')));
  // Failed saves roll back; an in-flight second click cannot win over the transaction.
  await page.locator('#themeToggle').click();
  await page.evaluate(()=>{window.realThemePersist=persistSettingsPatch;persistSettingsPatch=()=>new Promise(resolve=>window.failThemeSave=()=>resolve({success:false,error:'STORAGE_FULL'}));});
  await page.locator('[data-preset="obsidian"]').click();
  assert(await page.locator('.theme-card').first().isDisabled());
  assert.equal(await page.locator('body').getAttribute('data-theme-preset'),'obsidian');
  await page.evaluate(()=>window.failThemeSave());
  await page.waitForFunction(()=>document.body.dataset.themePreset==='cobalt');
  settings=await worker.evaluate(async()=> (await chrome.storage.local.get('xporter_settings')).xporter_settings);
  assert.equal(settings.themePreset,'cobalt');
  await page.evaluate(()=>{persistSettingsPatch=window.realThemePersist;});
  await page.keyboard.press('Escape');
  await page.locator('#tabBtnSettings').click();
  assert.equal(await page.locator('#simplifiedDesign,#backgroundEditor').count(),0);
  await page.locator('#openThemePicker').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#openThemePicker').evaluate(e=>e===document.activeElement),true);
  // Large/small interface scales, long translations and RTL retain a reachable dialog.
  for (const language of fs.readdirSync(path.join(root,'popup/locales')).filter(n=>n.endsWith('.json')).map(n=>n.slice(0,-5))) for (const uiScale of [80,100,130]) {
   await worker.evaluate(s=>chrome.storage.local.set({xporter_settings:s}),{language,theme:'light',themePreset:'glass-light',uiScale,ladybugEnabled:false});
   await page.setViewportSize({width:Math.round(350*uiScale/100),height:600});
   await page.goto(url);await page.waitForFunction(()=>document.querySelector('#postSelectionCount').textContent.includes('5'));
   await page.locator('#themeToggle').click();
   const r=await page.locator('#themePicker').boundingBox();
   const viewport=page.viewportSize();assert(r.x>=-1&&r.y>=-1&&r.x+r.width<=viewport.width+1&&r.y+r.height<=601,JSON.stringify({language,uiScale,r}));
   assert(await page.locator('.theme-mini').evaluateAll(es => es.every(e => { const r=e.getBoundingClientRect();const b=e.querySelector('.theme-mini-action').getBoundingClientRect();return b.bottom<=r.bottom; })), 'miniature action must not be clipped');
   await page.locator('[data-preset="iris"]').scrollIntoViewIfNeeded();
   assert(await page.locator('[data-preset="iris"]').isVisible());
   if(language==='ru'&&uiScale===100)await page.screenshot({path:path.join(out,'picker-light-ru.png')});
   await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: 11 themes; cobalt colors; persisted reload; export settings preserved; rollback; duplicate prevention; settings entry; focus return; 42 locale/scale cases.');
 } finally { await context.close(); fs.rmSync(profile,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1});
