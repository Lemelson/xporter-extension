#!/usr/bin/env node

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

async function main() {
  const executablePath = process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-tooltip-'));
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
          exportMode: 'bookmarks',
          language: 'en'
        }
      });
    });
    await popup.reload({ waitUntil: 'domcontentloaded' });
    await popup.locator('[data-tab="settings"]').click();

    const trigger = popup.locator('#settingsBookmarksOnly .help-viewport.help-below');
    await trigger.waitFor({ state: 'visible' });
    await trigger.evaluate(element => {
      const tooltip = element.querySelector(':scope > .help-pop');
      tooltip.textContent = Array.from(
        { length: 180 },
        (_, index) => `Detailed bookmark context explanation ${index + 1}.`
      ).join(' ');
    });
    await trigger.hover();
    await popup.waitForFunction(() => {
      const tooltip = document.querySelector(
        '#settingsBookmarksOnly .help-viewport.help-below > .help-pop'
      );
      return tooltip && getComputedStyle(tooltip).display !== 'none';
    });

    const layout = await trigger.evaluate(element => {
      const tooltip = element.querySelector(':scope > .help-pop');
      const tooltipRect = tooltip.getBoundingClientRect();
      const triggerRect = element.getBoundingClientRect();
      const headerRect = document.querySelector('.header')?.getBoundingClientRect();
      const tabsRect = document.querySelector('.tabs')?.getBoundingClientRect();
      const footerRect = document.querySelector('.footer')?.getBoundingClientRect();
      const safeTop = Math.max(headerRect?.bottom || 0, tabsRect?.bottom || 0, 8) + 4;
      const safeBottom = footerRect && footerRect.top < window.innerHeight
        ? footerRect.top - 8
        : window.innerHeight - 8;
      const belowTop = Math.max(safeTop, triggerRect.bottom + 8);
      const aboveBottom = triggerRect.top - 8;
      const availableBelow = Math.max(0, safeBottom - belowTop);
      const availableAbove = Math.max(0, aboveBottom - safeTop);
      const borderHeight = parseFloat(getComputedStyle(tooltip).borderTopWidth) +
        parseFloat(getComputedStyle(tooltip).borderBottomWidth);
      return {
        safeTop,
        safeBottom,
        availableAbove,
        availableBelow,
        naturalHeight: tooltip.scrollHeight + borderHeight,
        tooltipTop: tooltipRect.top,
        tooltipBottom: tooltipRect.bottom,
        triggerTop: triggerRect.top,
        triggerBottom: triggerRect.bottom,
        clientHeight: tooltip.clientHeight,
        scrollHeight: tooltip.scrollHeight
      };
    });

    assert(
      layout.naturalHeight > layout.availableAbove &&
      layout.naturalHeight > layout.availableBelow,
      `fixture must overflow both sides, got ${JSON.stringify(layout)}`
    );
    assert(
      layout.availableBelow > layout.availableAbove,
      `fixture must have more room below, got ${JSON.stringify(layout)}`
    );
    assert(
      layout.tooltipTop >= layout.triggerBottom,
      `when neither side fits, the larger side below must win: ${JSON.stringify(layout)}`
    );
    assert(
      layout.tooltipTop >= layout.safeTop - 1 &&
      layout.tooltipBottom <= layout.safeBottom + 1,
      `tooltip must stay inside the visible popup area: ${JSON.stringify(layout)}`
    );
    assert(
      layout.clientHeight > layout.availableAbove,
      `tooltip must not collapse to the smaller side: ${JSON.stringify(layout)}`
    );
    assert(
      layout.scrollHeight > layout.clientHeight,
      'an oversized tooltip must remain scrollable'
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
