#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const EXTENSION_ROOT = path.resolve(process.cwd());
const INTRO_KEY = 'xporter_photo_permission_intro_seen';
const LOCALES = ['en', 'ru', 'es', 'de', 'fr', 'pt', 'it', 'tr', 'id', 'hi', 'ja', 'ko', 'zh', 'ar'];

async function togglePhotoEmbedding(popup, checked) {
  const selector = checked ? '#xlsxPhotoEmbed' : '#xlsxPhotoLinks';
  await popup.locator(selector).evaluate((control) => {
    control.checked = true;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
}

async function main() {
  const executablePath = process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-photo-rationale-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_ROOT}`,
      `--load-extension=${EXTENSION_ROOT}`
    ]
  });

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    }

    const extensionId = new URL(serviceWorker.url()).host;
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 350, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });

    for (const language of LOCALES) {
      await popup.evaluate(async ({ lang, introKey }) => {
        const stored = await chrome.storage.local.get('xporter_settings');
        await chrome.storage.local.set({
          xporter_settings: {
            ...(stored.xporter_settings || {}),
            language: lang,
            exportMode: 'posts',
            outputFormat: 'xlsx',
            embedPostPhotos: false
          }
        });
        await chrome.storage.local.remove(introKey);
      }, { lang: language, introKey: INTRO_KEY });
      await popup.reload({ waitUntil: 'domcontentloaded' });

      await togglePhotoEmbedding(popup, true);
      const dialog = popup.locator('#photoPermissionDialog');
      await dialog.waitFor({ state: 'visible' });

      const layout = await dialog.evaluate(element => {
        const card = element.querySelector('.risk-dialog-card');
        const body = element.querySelector('#photoPermissionBody');
        const confirm = element.querySelector('#photoPermissionConfirm');
        const cancel = element.querySelector('#photoPermissionCancel');
        const cardRect = card.getBoundingClientRect();
        const confirmRect = confirm.getBoundingClientRect();
        const cancelRect = cancel.getBoundingClientRect();
        const iconRect = element.querySelector('.photo-permission-icon').getBoundingClientRect();
        const heading = element.querySelector('.photo-permission-heading');
        const actions = element.querySelector('.risk-dialog-actions');
        return {
          title: element.querySelector('#photoPermissionTitle').textContent.trim(),
          body: body.textContent.trim(),
          bodyFits: body.scrollHeight <= body.clientHeight + 1,
          boldCount: body.querySelectorAll('strong').length,
          confirmDisabled: confirm.disabled,
          confirmText: confirm.textContent.trim(),
          cardLeft: cardRect.left,
          cardRight: cardRect.right,
          cardTop: cardRect.top,
          cardBottom: cardRect.bottom,
          actionsInsideCard:
            cancelRect.top >= cardRect.top && confirmRect.top >= cardRect.top &&
            cancelRect.bottom <= cardRect.bottom && confirmRect.bottom <= cardRect.bottom,
          iconInsideCard:
            iconRect.left >= cardRect.left && iconRect.right <= cardRect.right &&
            iconRect.top >= cardRect.top && iconRect.bottom <= cardRect.bottom,
          actionLabelsFit:
            cancel.scrollWidth <= cancel.clientWidth + 1 &&
            cancel.scrollHeight <= cancel.clientHeight + 1 &&
            confirm.scrollWidth <= confirm.clientWidth + 1 &&
            confirm.scrollHeight <= confirm.clientHeight + 1,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          horizontalOverflow: card.scrollWidth > card.clientWidth + 1,
          cardClientWidth: card.clientWidth,
          cardScrollWidth: card.scrollWidth,
          childWidths: {
            heading: [heading.clientWidth, heading.scrollWidth],
            body: [body.clientWidth, body.scrollWidth],
            actions: [actions.clientWidth, actions.scrollWidth]
          }
        };
      });

      assert(layout.title.length > 0, `${language}: dialog title must be localized`);
      assert(layout.body.includes('pbs.twimg.com'), `${language}: dialog must name the exact image host`);
      assert.equal(layout.bodyFits, true, `${language}: the full explanation must fit without scrolling`);
      assert(layout.boldCount >= 2, `${language}: dialog must emphasize the permission summary and host`);
      assert.equal(layout.confirmDisabled, true, `${language}: Continue must start disabled`);
      assert.match(layout.confirmText, /3|٣|۳/, `${language}: Continue must start with a three-second guard`);
      assert.doesNotMatch(
        layout.confirmText,
        /\(\s*[0-9٠-٩۰-۹]+\s*\)$/u,
        `${language}: the countdown must name its time unit instead of showing an ambiguous number`
      );
      assert.equal(
        layout.horizontalOverflow,
        false,
        `${language}: dialog must not overflow horizontally (${layout.cardClientWidth}/${layout.cardScrollWidth}; ${JSON.stringify(layout.childWidths)})`
      );
      assert.equal(layout.actionsInsideCard, true, `${language}: both actions must remain visible`);
      assert.equal(layout.iconInsideCard, true, `${language}: warning icon must remain inside the card`);
      assert.equal(layout.actionLabelsFit, true, `${language}: action labels must not be clipped`);
      assert(
        layout.cardLeft >= 0 && layout.cardRight <= layout.viewportWidth &&
        layout.cardTop >= 0 && layout.cardBottom <= layout.viewportHeight,
        `${language}: dialog card must stay inside the 350×600 popup`
      );

      if (language === 'ru' && process.env.XPORTER_PHOTO_RATIONALE_SCREENSHOT) {
        await popup.screenshot({
          path: process.env.XPORTER_PHOTO_RATIONALE_SCREENSHOT,
          fullPage: false
        });
      }

      await popup.mouse.click(4, 4);
      assert.equal(await dialog.isVisible(), true, `${language}: backdrop click must not skip the explanation`);
      await popup.locator('#photoPermissionCancel').click();
      assert.equal(await popup.locator('#xlsxPhotoLinks').isChecked(), true);
      assert.equal(
        await popup.evaluate(introKey =>
          chrome.storage.local.get(introKey).then(value => value[introKey] === true), INTRO_KEY),
        false,
        `${language}: cancelling must not mark the explanation as completed`
      );
    }

    await popup.evaluate(async (introKey) => {
      const stored = await chrome.storage.local.get('xporter_settings');
      await chrome.storage.local.set({
        xporter_settings: {
          ...(stored.xporter_settings || {}),
          language: 'en',
          embedPostPhotos: false
        }
      });
      await chrome.storage.local.remove(introKey);
    }, INTRO_KEY);
    await popup.reload({ waitUntil: 'domcontentloaded' });
    await togglePhotoEmbedding(popup, true);
    const guardedConfirm = popup.locator('#photoPermissionConfirm');
    const countdownStartedAt = Date.now();
    await popup.waitForFunction(() => {
      const button = document.getElementById('photoPermissionConfirm');
      return button && !button.disabled;
    }, null, { timeout: 5_000 });
    assert(
      Date.now() - countdownStartedAt >= 2_800,
      'Continue must remain guarded for approximately three seconds'
    );
    await guardedConfirm.click();
    await popup.waitForFunction(introKey =>
      chrome.storage.local.get(introKey).then(value => value[introKey] === true), INTRO_KEY);

    await popup.reload({ waitUntil: 'domcontentloaded' });
    await popup.waitForFunction(async () => {
      const permission = await chrome.permissions.contains({
        origins: ['https://pbs.twimg.com/*']
      });
      const stored = await chrome.storage.local.get('xporter_settings');
      return permission || stored.xporter_settings?.embedPostPhotos === false;
    });
    await togglePhotoEmbedding(popup, true);
    assert.equal(
      await popup.locator('#photoPermissionDialog').isVisible(),
      false,
      'a completed explanation must not be shown again'
    );

    // Playwright's headless extension context does not retain an optional host
    // grant across reloads. The dialog above exercises the real API; this
    // isolated phase stubs only the grant check so mode-specific persistence
    // can be tested independently from that browser limitation.
    await popup.addInitScript(() => {
      chrome.permissions.contains = async () => true;
    });
    await popup.evaluate(async () => {
      const stored = await chrome.storage.local.get('xporter_settings');
      await chrome.storage.local.set({
        xporter_settings: {
          ...(stored.xporter_settings || {}),
          exportMode: 'posts',
          outputFormat: 'xlsx',
          embedPostPhotos: true,
          embedBookmarkPhotos: false
        }
      });
    });
    await popup.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await popup.locator('#xlsxPhotoEmbed').isChecked(), true);

    await popup.locator('#exportMode').selectOption('bookmarks');
    await popup.locator('#outputFormat').selectOption('xlsx');
    await popup.waitForFunction(() =>
      chrome.storage.local.get('xporter_settings')
        .then(value => value.xporter_settings?.exportMode === 'bookmarks')
    );
    assert.equal(
      await popup.locator('#xlsxPhotoLinks').isChecked(),
      true,
      'Bookmarks must retain its independent links-only default'
    );
    await popup.locator('#exportMode').selectOption('posts');
    assert.equal(
      await popup.locator('#xlsxPhotoEmbed').isChecked(),
      true,
      'Posts must retain embedded previews after switching to Bookmarks'
    );
    await popup.locator('#exportMode').selectOption('bookmarks');
    assert.equal(await popup.locator('#xlsxPhotoLinks').isChecked(), true);
    await popup.locator('#outputFormat').selectOption('csv');
    assert.equal(await popup.locator('#xlsxPhotoOptions').isVisible(), false);
    await popup.locator('#outputFormat').selectOption('xlsx');
    assert.equal(await popup.locator('#xlsxPhotoLinks').isChecked(), true);
    await popup.waitForFunction(() =>
      chrome.storage.local.get('xporter_settings').then(value =>
        value.xporter_settings?.exportMode === 'bookmarks' &&
        value.xporter_settings?.outputFormat === 'xlsx'
      )
    );
    await popup.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await popup.locator('#xlsxPhotoLinks').isChecked(), true);

    console.log(`Photo permission rationale passed in ${LOCALES.length} locales.`);
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
