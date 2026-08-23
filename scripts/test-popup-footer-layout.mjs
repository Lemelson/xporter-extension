#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const EXTENSION_ROOT = path.resolve(process.cwd());

async function main() {
  const executablePath = process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-footer-'));
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
          outputFormat: 'xlsx',
          language: 'ru'
        }
      });
    });
    await popup.reload({ waitUntil: 'domcontentloaded' });
    await popup.locator('#tab-home').waitFor({ state: 'visible' });
    await popup.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    const layout = await popup.evaluate(() => {
      const popupRect = document.getElementById('popup').getBoundingClientRect();
      const footerRect = document.querySelector('.footer').getBoundingClientRect();
      return {
        viewportHeight: window.innerHeight,
        popupBottom: popupRect.bottom,
        footerBottom: footerRect.bottom,
        footerHeight: footerRect.height,
        scrollY: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        bodyScrollHeight: document.body.scrollHeight,
        bodyHeight: document.body.getBoundingClientRect().height,
        htmlHeight: document.documentElement.getBoundingClientRect().height,
        trailingElements: [...document.querySelectorAll('body *')]
          .map(element => {
            const rect = element.getBoundingClientRect();
            return {
              id: element.id,
              className: typeof element.className === 'string' ? element.className : '',
              position: getComputedStyle(element).position,
              bottom: rect.bottom + window.scrollY
            };
          })
          .filter(element => element.bottom > popupRect.bottom + window.scrollY + 1)
          .sort((a, b) => b.bottom - a.bottom)
          .slice(0, 10)
      };
    });

    if (process.env.XPORTER_FOOTER_SCREENSHOT) {
      await popup.screenshot({
        path: process.env.XPORTER_FOOTER_SCREENSHOT,
        fullPage: false
      });
    }

    assert(
      Math.abs(layout.popupBottom - layout.footerBottom) <= 1,
      `the popup must end at the version footer, got ${JSON.stringify(layout)}`
    );
    assert(
      Math.abs(layout.viewportHeight - layout.popupBottom) <= 1,
      `the scrolled home tab must not leave a strip below the version footer, got ${JSON.stringify(layout)}`
    );

    console.log(JSON.stringify(layout, null, 2));
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
