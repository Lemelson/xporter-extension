#!/usr/bin/env node
// Browser contract for the 2026-09-22 popup review fixes: guarded mode switch,
// history-download isolation, date-range validation, settings-load failure,
// language-menu keyboard access, confirmed clearing and closing-flush of edits.
// Uses a disposable profile and synthetic storage; no X request is made.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';

try {
  toolingPolicy.assertBrowserSmokeCanLaunch();
} catch (error) {
  console.error(`${error.code || 'BROWSER_SMOKE_BLOCKED'}: ${error.message}`);
  process.exit(1);
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.resolve(process.cwd());
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'popup/locales/en.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(ROOT, 'popup/locales/ru.json'), 'utf8'));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-review-fixes-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(),
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`]
});

const stoppedState = (timestamp) => ({
  username: 'example', userId: '1', userInfo: { name: 'Example', screenName: 'example' },
  exportMode: 'posts', outputFormat: 'csv', status: 'stopped', running: false,
  tweetCount: 25, expectedTweets: 500, totalBatches: 2,
  startedAt: timestamp - 30_000, updatedAt: timestamp, settings: { quantityLimit: 500 }
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const url = `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;

  async function seed(values) {
    await worker.evaluate(async (values) => {
      currentExport = null;
      await chrome.storage.local.clear();
      await chrome.storage.local.set(values);
    }, values);
  }
  const stored = key => worker.evaluate(async key => (await chrome.storage.local.get(key))[key], key);
  async function open(page = null) {
    const target = page || await context.newPage();
    const errors = [];
    target.on('pageerror', error => errors.push(error.message));
    // Form defaults render before the async init finishes. Wait for the last
    // module's actual event registration, not an early visible label.
    await target.addInitScript(() => {
      const original = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (type, ...args) {
        const result = original.call(this, type, ...args);
        if (this.id === 'feedDbToggle' && type === 'click') window.__popupReady = true;
        return result;
      };
    });
    await target.setViewportSize({ width: 350, height: 600 });
    await target.goto(url);
    await target.waitForFunction(() => document.getElementById('postSelectionCount').textContent.includes('/5'));
    await target.waitForFunction(() => window.__popupReady);
    return { page: target, errors };
  }
  // The quantity select lives on the (inactive) Settings tab.
  const chooseQuantity = (page, value) => page.evaluate((value) => {
    const select = document.getElementById('quantityLimit');
    select.value = value;
    select.dispatchEvent(new Event('change'));
  }, value);
  const dialogOpen = page => page.evaluate(() =>
    !document.getElementById('aboutRiskDialog').classList.contains('hidden'));

  // ---- Mode switch over unsaved rows asks first; Cancel keeps everything.
  {
    await seed({
      xporter_settings: { exportMode: 'posts', outputFormat: 'csv', language: 'en' },
      xporter_export_state: stoppedState(Date.now())
    });
    const { page, errors } = await open();
    await page.locator('#resumeBtn').waitFor({ state: 'visible' });
    await page.selectOption('#exportMode', 'followers');
    await page.waitForFunction(() => !document.getElementById('aboutRiskDialog').classList.contains('hidden'));
    assert.equal(await page.textContent('#aboutRiskTitle'), en.modeChangeTitle);
    assert.equal(await page.inputValue('#exportMode'), 'posts', 'the select must not switch before confirmation');
    assert.equal(await page.isEnabled('#aboutRiskConfirm'), true, 'destructive confirmation has no countdown');
    await page.click('#aboutRiskCancel');
    assert.equal(await dialogOpen(page), false);
    assert.equal(await page.inputValue('#exportMode'), 'posts');
    assert.equal(await page.isVisible('#exportStatus'), true, 'Cancel must keep the stopped export');
    assert.equal((await stored('xporter_settings')).exportMode, 'posts');
    assert.equal((await stored('xporter_export_state'))?.tweetCount, 25);

    // ---- History download progress never locks Home; current progress does,
    // and a language switch keeps the active download label.
    await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', source: 'history',
      partNumber: 1, partCount: 2 }).catch(() => {}));
    await page.waitForTimeout(200);
    assert.equal(await page.isEnabled('#downloadBtn'), true, 'history progress must not lock Download');
    assert.equal(await page.isEnabled('#exportMode'), true, 'history progress must not lock the mode');
    // Synthetic progress needs the matching worker plan; an inactive real
    // plan now correctly reconciles a missing terminal broadcast.
    await page.evaluate(() => {
      const original = sendMessage;
      window.__currentDownloadActive = true;
      sendMessage = (message, ...args) => message.type === 'GET_DOWNLOAD_PLAN' && window.__currentDownloadActive
        ? Promise.resolve({ count: 25, multipart: false, active: true }) : original(message, ...args);
    });
    await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', source: 'current',
      partNumber: 1, partCount: 2 }).catch(() => {}));
    await page.waitForFunction(() => document.getElementById('downloadBtn').disabled);
    await page.click('#langBtn');
    await page.locator('.lang-option').filter({ hasText: 'Русский' }).click();
    await page.waitForFunction(() => document.documentElement.lang === 'ru');
    assert.equal((await page.textContent('#downloadBtn [data-i18n="download"]')).trim(), '1 / 2',
      'a language switch must not reset an active download label');
    await page.evaluate(() => { window.__currentDownloadActive = false; });
    await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', source: 'current',
      error: 'DOWNLOAD_FAILED' }).catch(() => {}));
    await page.waitForFunction(() => !document.getElementById('downloadBtn').disabled);
    assert.equal(await page.evaluate(() => document.querySelector('#toastRegion .toast')?.hasAttribute('role')), false,
      'toasts are announced by the persistent region, not per-node roles');
    assert.equal(await page.getAttribute('#toastRegion', 'aria-live'), 'polite');

    // No COMPLETE/ERROR broadcast: polling the inactive worker plan unlocks
    // every action and restores the export's stopped status text.
    await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', source: 'current',
      partNumber: 1, partCount: 2 }).catch(() => {}));
    await page.waitForFunction(() => document.getElementById('downloadBtn').disabled);
    await page.waitForFunction(() => !document.getElementById('downloadBtn').disabled);
    assert.equal(await page.isEnabled('#exportMode'), true, 'inactive worker plan must unlock mode');
    assert.equal(await page.isEnabled('#newExportBtn'), true, 'inactive worker plan must unlock New Export');
    assert.equal((await page.textContent('#statusMessage')).trim(), ru.canBeResumed);

    // ---- Confirming the switch persists the mode and clears the export.
    await page.selectOption('#exportMode', 'followers');
    await page.waitForFunction(() => !document.getElementById('aboutRiskDialog').classList.contains('hidden'));
    assert.equal(await page.textContent('#aboutRiskTitle'), ru.modeChangeTitle);
    await page.click('#aboutRiskConfirm');
    await page.waitForFunction(() => document.getElementById('exportStatus').classList.contains('hidden'));
    assert.equal(await page.inputValue('#exportMode'), 'followers');
    assert.equal((await stored('xporter_settings')).exportMode, 'followers');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ---- Idle: no rows at stake, the switch is immediate.
  {
    await seed({ xporter_settings: { exportMode: 'posts', outputFormat: 'csv', language: 'en' } });
    const { page, errors } = await open();
    await page.selectOption('#exportMode', 'bookmarks');
    await page.waitForTimeout(300);
    assert.equal(await dialogOpen(page), false, 'idle mode switches need no confirmation');
    assert.equal((await stored('xporter_settings')).exportMode, 'bookmarks');

    // Sign-in banner is one localized sentence (no leaked fragment keys).
    const banner = await page.evaluate(() => document.querySelector('#authWarning [data-i18n-template]').textContent);
    assert.equal(banner.replace(/\s+/g, ' ').trim(), en.authRequired.replace('{link}', en.authLink));
    assert.equal(await page.getAttribute('#githubLink', 'aria-label'), en.viewSource);
    assert.match(await page.textContent('.footer-build-date'), /2026/);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ---- Date range enabled without a date never starts an ordinary export.
  {
    await seed({ xporter_settings: { exportMode: 'posts', outputFormat: 'csv', language: 'en' } });
    const { page, errors } = await open();
    await page.evaluate(() => {
      document.getElementById('usernameInput').value = 'example';
      const dateCheck = document.getElementById('dateCheck');
      dateCheck.checked = true;
      dateCheck.dispatchEvent(new Event('change'));
      document.getElementById('startBtn').click();
    });
    await page.waitForFunction(() => !document.getElementById('dateRangeError').classList.contains('hidden'));
    assert.equal(await page.textContent('#dateRangeError'), en.errDateRangeRequired);
    assert.equal(await page.getAttribute('#dateFrom', 'aria-invalid'), 'true');
    assert.equal(await worker.evaluate(() => currentExport), null, 'no export may start');
    assert.equal(await page.isEnabled('#startBtn'), true, 'Start is re-enabled after a rejected click');
    await page.fill('#dateFrom', '2026-01-01');
    assert.equal(await page.isVisible('#dateRangeError'), false, 'editing a date clears the error');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ---- Language menu keyboard access.
  {
    await seed({ xporter_settings: { language: 'en' } });
    const { page } = await open();
    assert.equal(await page.getAttribute('#langBtn', 'aria-label'), 'Language: English');
    await page.focus('#langBtn');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.isVisible('#langDropdown'), true);
    assert.deepEqual(await page.evaluate(() => [document.activeElement.className,
      document.activeElement.getAttribute('aria-checked'), document.activeElement.lang]),
    ['lang-option active', 'true', 'en'], 'focus moves to the selected language');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.lang), 'zh');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.lang), 'id');
    await page.keyboard.press('Escape');
    // The menu fades out briefly; it is already inert while it does.
    await page.locator('#langDropdown').waitFor({ state: 'hidden', timeout: 1000 });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'langBtn', 'Escape returns focus');
    assert.equal(await page.getAttribute('#langBtn', 'aria-expanded'), 'false');
    await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('#langDropdown'), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.getAttribute('#langBtn', 'aria-expanded'), 'false', 'Tab closes the menu');
    await page.locator('#langDropdown').waitFor({ state: 'hidden', timeout: 1000 });
    await page.close();
  }

  // ---- Clearing history and seen posts asks first; emoji initials stay whole.
  {
    const now = Date.now();
    await seed({
      xporter_settings: { language: 'en' },
      xporter_export_history: [1, 2].map(id => ({ id: `h${id}`, username: `user${id}`,
        displayName: '😀 Emoji', exportMode: 'posts', itemCount: 3, outputFormat: 'csv',
        completedAt: now, hasData: false }))
    });
    const { page, errors } = await open();
    // History mounts at the end of popup init; open it once its handler exists.
    await page.waitForFunction(() => {
      if (document.getElementById('historyList').classList.contains('hidden')) {
        document.getElementById('historyToggle').click();
      }
      return document.querySelector('.history-clear-btn');
    }, null, { polling: 200 });
    assert.equal(await page.textContent('.history-avatar-placeholder'), '😀');
    await page.evaluate(() => document.querySelector('.history-clear-btn').click());
    await page.waitForFunction(() => !document.getElementById('aboutRiskDialog').classList.contains('hidden'));
    assert.equal(await page.textContent('#aboutRiskTitle'), en.clearHistoryTitle);
    await page.click('#aboutRiskCancel');
    assert.equal((await stored('xporter_export_history')).length, 2, 'Cancel keeps history');
    await page.evaluate(() => document.querySelector('.history-clear-btn').click());
    await page.waitForFunction(() => !document.getElementById('aboutRiskDialog').classList.contains('hidden'));
    await page.click('#aboutRiskConfirm');
    await page.waitForFunction(() => !document.querySelector('.history-card'));
    assert.equal((await stored('xporter_export_history') || []).length, 0);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ---- A failed settings load is retried, reported, and never persisted over.
  {
    await seed({ xporter_settings: { language: 'de', quantityLimit: 500 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__sent = [];
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, callback) => {
        window.__sent.push(message?.type);
        if (message?.type === 'GET_SETTINGS') {
          setTimeout(() => callback({}), 0);
          return undefined;
        }
        return original(message, callback);
      };
    });
    const { errors } = await open(page);
    await page.waitForFunction(() => document.querySelector('#toastRegion .toast-error'));
    const browserLanguage = await page.evaluate(() => document.documentElement.lang);
    const expectedLocale = JSON.parse(fs.readFileSync(path.join(ROOT, `popup/locales/${browserLanguage}.json`), 'utf8'));
    assert.equal(await page.textContent('#toastRegion .toast-error'), expectedLocale.errSettingsUnavailable);
    await chooseQuantity(page, '1000');
    await page.waitForTimeout(800);
    const sent = await page.evaluate(() => window.__sent);
    assert.equal(sent.filter(type => type === 'GET_SETTINGS').length, 3, 'GET_SETTINGS is retried');
    assert.equal(sent.includes('SAVE_SETTINGS'), false, 'nothing may be saved over unloaded settings');
    assert.deepEqual(await stored('xporter_settings'), { language: 'de', quantityLimit: 500 });
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ---- Failed status reads are not idle and cannot erase a saved export.
  {
    await seed({ xporter_settings: { language: 'en', exportMode: 'posts' },
      xporter_export_state: stoppedState(Date.now()) });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__sent = [];
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, callback) => {
        window.__sent.push(message);
        if (message?.type === 'GET_STATUS' && !window.__statusRecovered) {
          setTimeout(() => callback({ error: 'STORAGE_READ_FAILED' }), 0);
          return undefined;
        }
        return original(message, callback);
      };
    });
    const { errors } = await open(page);
    assert.equal(await page.isEnabled('#startBtn'), false);
    assert.equal(await page.isEnabled('#exportMode'), false);
    assert.equal(await page.isEnabled('#newExportBtn'), false);
    assert.equal(await page.textContent('#toastRegion .toast-error'), en.errStorageReadFailed);
    await page.evaluate(() => {
      document.getElementById('usernameInput').value = 'otheruser';
      document.getElementById('startBtn').click();
      document.getElementById('newExportBtn').click();
      const mode = document.getElementById('exportMode');
      mode.value = 'followers';
      mode.dispatchEvent(new Event('change'));
    });
    assert.equal(await page.inputValue('#exportMode'), 'posts');
    const destructive = await page.evaluate(() => window.__sent.filter(message =>
      ['START_EXPORT', 'CLEAR_EXPORT'].includes(message.type) ||
      (message.type === 'SAVE_SETTINGS' && message.settings.exportMode)));
    assert.deepEqual(destructive, [], 'unreadable saved state must not be replaced');
    assert.equal((await stored('xporter_export_state')).tweetCount, 25);
    await page.evaluate(() => { window.__statusRecovered = true; });
    await page.locator('#resumeBtn').waitFor({ state: 'visible' });
    assert.equal(await page.isEnabled('#exportMode'), true);
    assert.equal((await stored('xporter_export_state')).tweetCount, 25);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ---- A failed clear must roll back the mode and preserve the current rows.
  {
    await seed({ xporter_settings: { exportMode: 'posts', outputFormat: 'txt', language: 'en' },
      xporter_export_state: stoppedState(Date.now()) });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type === 'CLEAR_EXPORT') {
          setTimeout(() => callback({ error: 'STORAGE_FULL' }), 0);
          return undefined;
        }
        return original(message, callback);
      };
    });
    await open(page);
    await page.locator('#resumeBtn').waitFor({ state: 'visible' });
    await page.selectOption('#exportMode', 'followers');
    await page.click('#aboutRiskConfirm');
    await page.waitForFunction(() => document.querySelector('#toastRegion .toast-error'));
    assert.equal(await page.inputValue('#exportMode'), 'posts', 'a failed clear keeps the original mode');
    assert.equal(await page.inputValue('#outputFormat'), 'txt', 'a failed clear keeps the original format');
    assert.equal((await stored('xporter_settings')).exportMode, 'posts');
    assert.equal((await stored('xporter_settings')).outputFormat, 'txt');
    assert.equal((await stored('xporter_export_state')).tweetCount, 25);
    await page.close();
  }

  // ---- Resume can validly report an already exhausted source; never fake running.
  {
    const state = stoppedState(Date.now());
    await seed({ xporter_settings: { language: 'en' }, xporter_export_state: state });
    const page = await context.newPage();
    await page.addInitScript(state => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let resumed = false;
      chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type === 'RESUME_EXPORT') {
          resumed = true;
          setTimeout(() => callback({ success: true, status: 'complete', tweetCount: 25 }), 0);
          return undefined;
        }
        if (message?.type === 'GET_STATUS' && resumed) {
          setTimeout(() => callback({ ...state, status: 'complete', running: false,
            hasMore: false, completionReason: 'source_exhausted' }), 0);
          return undefined;
        }
        return original(message, callback);
      };
    }, state);
    const { errors } = await open(page);
    await page.click('#resumeBtn');
    await page.waitForFunction(expected => document.getElementById('statusText').textContent.trim() === expected,
      en.exportComplete);
    assert.equal(await page.isVisible('#stopBtn'), false);
    assert.equal(await page.isEnabled('#exportMode'), true);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ---- Stop timeout means still stopping until the status poll settles it.
  {
    const state = { ...stoppedState(Date.now()), status: 'fetching', running: true };
    await seed({ xporter_settings: { language: 'en' } });
    const page = await context.newPage();
    await page.addInitScript(state => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type === 'STOP_EXPORT') {
          setTimeout(() => callback({ error: 'TIMEOUT' }), 0);
          return undefined;
        }
        if (message?.type === 'GET_STATUS') {
          setTimeout(() => callback(window.__stopSettled
            ? { ...state, status: 'stopped', running: false }
            : state), 0);
          return undefined;
        }
        return original(message, callback);
      };
    }, state);
    const { errors } = await open(page);
    await page.click('#stopBtn');
    await page.waitForFunction(() => !document.getElementById('stopBtn').disabled);
    assert.equal(await page.textContent('#statusMessage'), en.ovStopping);
    assert.equal(await page.isVisible('#resumeBtn'), false);
    await page.evaluate(() => { window.__stopSettled = true; });
    await page.locator('#resumeBtn').waitFor({ state: 'visible' });
    assert.equal(await page.isVisible('#stopBtn'), false);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ---- Reverting a form control while its previous save is pending wins.
  {
    await seed({ xporter_settings: { language: 'en', quantityLimit: 500 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__formWrites = [];
      chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type === 'SAVE_SETTINGS') window.__formWrites.push(message.settings);
        if (message?.type === 'SAVE_SETTINGS' && message.settings.quantityLimit === 1000) {
          window.__quantitySavePending = true;
          setTimeout(() => original(message, callback), 1400);
          return undefined;
        }
        return original(message, callback);
      };
    });
    await open(page);
    await chooseQuantity(page, '1000');
    await page.waitForFunction(() => window.__quantitySavePending);
    await chooseQuantity(page, '500');
    await page.waitForTimeout(2200);
    assert.equal((await stored('xporter_settings')).quantityLimit, 500,
      'the later edit cannot be dropped while the earlier save is awaiting a reply');
    assert.deepEqual(await page.evaluate(() => window.__formWrites),
      [{ quantityLimit: 1000 }, { quantityLimit: 500 }], 'both saves contain only the edited field');
    await chooseQuantity(page, '500');
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(() => window.__formWrites.length), 2, 'a no-op flush sends nothing');
    await page.evaluate(() => {
      const control = document.getElementById('localizeExportHeaders');
      control.checked = false;
      control.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(() => window.__formWrites.length === 3);
    assert.deepEqual(await page.evaluate(() => window.__formWrites[2]), { localizeExportHeaders: false },
      'an unrelated edit does not resend any other form values');
    await page.close();
  }

  // ---- A removed history entry must not reappear when switching languages.
  {
    await seed({ xporter_settings: { language: 'en' },
      xporter_export_history: [1, 2].map(id => ({ id: `delete-${id}`, username: `user${id}`,
        exportMode: 'posts', itemCount: 3, completedAt: Date.now(), hasData: false })) });
    const { page } = await open();
    await page.waitForFunction(() => {
      if (document.getElementById('historyList').classList.contains('hidden')) {
        document.getElementById('historyToggle').click();
      }
      return document.querySelector('.history-del-btn');
    }, null, { polling: 200 });
    await page.evaluate(() => document.querySelector('.history-del-btn').click());
    await page.waitForFunction(() => document.querySelectorAll('.history-card').length === 1);
    await page.click('#langBtn');
    await page.locator('.lang-option').filter({ hasText: 'Русский' }).click();
    await page.waitForFunction(() => document.documentElement.lang === 'ru');
    assert.equal(await page.locator('.history-card').count(), 1,
      'language refresh must not resurrect the deleted entry from a stale render cache');
    assert.equal((await stored('xporter_export_history')).length, 1);
    await page.close();
  }

  // ---- An edit still inside the autosave debounce is flushed when the popup closes.
  {
    await seed({ xporter_settings: { language: 'en', quantityLimit: 500 } });
    const { page } = await open();
    await chooseQuantity(page, '1000');
    await page.close({ runBeforeUnload: true });
    const deadline = Date.now() + 3000;
    let limit;
    while (Date.now() < deadline) {
      limit = (await stored('xporter_settings'))?.quantityLimit;
      if (limit === 1000) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(limit, 1000, 'closing the popup must flush the pending settings edit');
  }

  // ---- Closing also flushes a revert while the preceding write awaits its reply.
  {
    await seed({ xporter_settings: { language: 'en', quantityLimit: 500 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type === 'SAVE_SETTINGS' && message.settings.quantityLimit === 1000) {
          return original(message, result => {
            window.__quantitySavePending = true;
            setTimeout(() => callback(result), 1400);
          });
        }
        return original(message, callback);
      };
    });
    await open(page);
    await chooseQuantity(page, '1000');
    await page.waitForFunction(() => window.__quantitySavePending);
    await chooseQuantity(page, '500');
    await page.close({ runBeforeUnload: true });
    const deadline = Date.now() + 3000;
    let limit;
    while (Date.now() < deadline) {
      limit = (await stored('xporter_settings'))?.quantityLimit;
      if (limit === 500) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(limit, 500, 'the final edit must be sent before the page is destroyed');
  }

  console.log('Popup review fixes passed: guarded mode switch, history download isolation, date validation, ' +
    'settings/status-load failures, status recovery, terminal Resume, delayed Stop, ' +
    'language menu keyboard, confirmed clearing, failed-clear rollback, ' +
    'overlapping autosaves, deleted-history language refresh, and close-time settings flush.');
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
