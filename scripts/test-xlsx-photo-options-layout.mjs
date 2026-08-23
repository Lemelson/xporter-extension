#!/usr/bin/env node
// Browser layout coverage for the two XLSX photo choices in every locale.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import toolingPolicy from './tooling-policy.js';

const { assertBrowserSmokeCanLaunch } = toolingPolicy;
try {
  assertBrowserSmokeCanLaunch();
} catch (error) {
  console.error(`${error.code || 'BROWSER_SMOKE_BLOCKED'}: ${error.message}`);
  process.exit(1);
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const EXTENSION_ROOT = path.resolve(process.cwd());
const LOCALES = ['en', 'ru', 'es', 'de', 'fr', 'pt', 'it', 'tr', 'id', 'hi', 'ja', 'ko', 'zh', 'ar'];

async function main() {
  const executablePath = process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-xlsx-photo-options-'));
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
    await popup.evaluate(async () => {
      const stored = await chrome.storage.local.get('xporter_settings');
      await chrome.storage.local.set({
        xporter_settings: {
          ...(stored.xporter_settings || {}),
          exportMode: 'posts',
          outputFormat: 'xlsx'
        }
      });
    });

    for (const language of LOCALES) {
      await popup.evaluate(async (lang) => {
        const stored = await chrome.storage.local.get('xporter_settings');
        await chrome.storage.local.set({
          xporter_settings: { ...(stored.xporter_settings || {}), language: lang }
        });
      }, language);
      await popup.reload({ waitUntil: 'domcontentloaded' });

      const panel = popup.locator('#xlsxPhotoOptions');
      await panel.waitFor({ state: 'visible' });

      const layout = await panel.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const choices = [...element.querySelectorAll('.xlsx-photo-choice')];
        return {
          title: element.querySelector('#xlsxPhotosTitle')?.textContent.trim() || '',
          rect: { left: rect.left, right: rect.right, width: rect.width },
          viewportWidth: window.innerWidth,
          direction: document.documentElement.dir || 'ltr',
          choiceCount: choices.length,
          choices: choices.map(choice => ({
            clientWidth: choice.clientWidth,
            scrollWidth: choice.scrollWidth,
            clientHeight: choice.clientHeight,
            scrollHeight: choice.scrollHeight
          }))
        };
      });

      assert(layout.title.length > 0, `${language}: photo-mode heading must be localized`);
      assert.equal(layout.choiceCount, 2, `${language}: links and previews must both be visible`);
      assert(
        layout.rect.left >= 0 && layout.rect.right <= layout.viewportWidth,
        `${language}: photo choices must stay inside the 350px popup`
      );
      for (const [index, choice] of layout.choices.entries()) {
        assert(
          choice.scrollWidth <= choice.clientWidth + 1,
          `${language}: choice ${index + 1} overflows horizontally`
        );
        assert(
          choice.scrollHeight <= choice.clientHeight + 1,
          `${language}: choice ${index + 1} clips translated text`
        );
      }
      assert.equal(
        layout.direction,
        language === 'ar' ? 'rtl' : 'ltr',
        `${language}: photo choices must follow the document direction`
      );

      if (language === 'ru' && process.env.XPORTER_XLSX_PHOTO_OPTIONS_SCREENSHOT) {
        await popup.screenshot({
          path: process.env.XPORTER_XLSX_PHOTO_OPTIONS_SCREENSHOT,
          fullPage: false
        });
      }
    }

    console.log(`XLSX photo choices fit without clipping in ${LOCALES.length} locales.`);
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
