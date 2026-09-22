const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./tooling-policy.js').assertBrowserSmokeCanLaunch();
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
(async () => {
  const profile = fs.mkdtempSync('/private/tmp/xporter-account-context-');
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const url = `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;
    for (const state of ['disconnected', 'connected', 'unrelated']) {
      const page = await context.newPage();
      await page.addInitScript(state => {
        window.reloadRequests = [];
        window.close = () => {};
        chrome.tabs.query = async () => [{ id: 123, url: state === 'unrelated' ? 'https://example.com/' : 'https://x.com/314zdc' }];
        chrome.tabs.reload = async id => { window.reloadRequests.push(id); };
        chrome.tabs.sendMessage = async () => {
          if (state === 'disconnected') throw new Error('Receiving end does not exist');
          return { currentAccount: null, targetAccount: { username: '314zdc', name: 'blessed', avatarUrl: 'https://pbs.twimg.com/profile_images/test/avatar.jpg' } };
        };
      }, state);
      await page.route('https://pbs.twimg.com/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64') }));
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#postSelectionCount').textContent.includes('5'));
      assert.deepEqual(await page.evaluate(() => window.reloadRequests), [], 'never reload the user tab automatically');
      if (state === 'disconnected') {
        assert(await page.locator('#accountContextNotice').isVisible(), 'missing content script must explain how to recover profile data');
        await page.locator('#reloadAccountTab').click();
        assert.deepEqual(await page.evaluate(() => window.reloadRequests), [123], 'reload only the requested X tab after a click');
      } else {
        assert(!await page.locator('#accountContextNotice').isVisible(), 'no recovery message on healthy or unrelated tabs');
        if (state === 'connected') {
          assert.equal(await page.locator('#targetAccountName').textContent(), 'blessed');
          await page.waitForFunction(() => document.querySelector('#targetAccountAvatar').naturalWidth > 0);
          assert(await page.locator('#targetAccountAvatar').isVisible(), 'profile avatar must render');
        }
      }
      await page.close();
    }
    console.log('PASS account context: connected avatar/name, explicit recovery after disconnect, no automatic reload or unrelated-page prompt');
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
