#!/usr/bin/env node
// Browser contract for the user-stopped export state and its Resume action.

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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-stopped-resume-'));
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
    const now = Date.now();
    await serviceWorker.evaluate(async (timestamp) => {
      await chrome.storage.local.set({
        xporter_settings: {
          exportMode: 'posts',
          outputFormat: 'xlsx',
          language: 'en'
        },
        xporter_export_state: {
          username: 'levelsio',
          userId: '1',
          userInfo: { name: 'Pieter Levels', screenName: 'levelsio' },
          exportMode: 'posts',
          outputFormat: 'xlsx',
          status: 'stopped',
          running: false,
          tweetCount: 1989,
          expectedTweets: 3200,
          totalBatches: 100,
          startedAt: timestamp - 30_000,
          updatedAt: timestamp,
          settings: { quantityLimit: 3200 }
        }
      });
    }, now);

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 350, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });
    await popup.locator('#resumeBtn').waitFor({ state: 'visible' });
    await popup.locator('#langBtn').click();
    await popup.locator('.lang-option').filter({ hasText: 'Русский' }).click();
    await popup.waitForFunction(
      () => document.getElementById('resumeBtn')?.textContent.includes('Продолжить')
    );

    const inspect = () => popup.evaluate(() => {
      const status = document.getElementById('exportStatus');
      const progress = document.getElementById('progressFill');
      const progressAfter = getComputedStyle(progress, '::after');
      const resume = document.getElementById('resumeBtn');
      const resumeIcon = resume.querySelector('.resume-play-icon');
      const stoppedIcon = document.querySelector('.stopped-state-icon');
      const resumableIcon = document.querySelector('#statusIndicator .resumable-state-icon');
      const statusInfo = document.querySelector('.status-info');
      const actionStack = document.getElementById('statusActionStack');
      const download = document.getElementById('downloadBtn');
      const statusInfoRect = statusInfo.getBoundingClientRect();
      const actionStackRect = actionStack.getBoundingClientRect();
      const downloadRect = download.getBoundingClientRect();
      const documentElement = document.documentElement;
      return {
        statusPhase: status.classList.contains('phase-stopped'),
        progressPhase: progress.classList.contains('stopped'),
        progressAnimation: getComputedStyle(progress).animationName,
        progressAfterDisplay: progressAfter.display,
        stoppedIconIsSvg: stoppedIcon?.tagName === 'svg',
        stoppedIconName: stoppedIcon?.dataset.tablerIcon || '',
        stoppedIconColor: stoppedIcon ? getComputedStyle(stoppedIcon).color : '',
        resumableCue: document.getElementById('statusIndicator')
          .classList.contains('status-resumable'),
        resumableIconName: resumableIcon?.dataset.tablerIcon || '',
        resumeIconName: resumeIcon?.dataset.tablerIcon || '',
        resumeTag: resume.tagName,
        resumeText: resume.textContent.trim(),
        resumeAnimation: getComputedStyle(resumeIcon).animationName,
        resumeOutlineStyle: getComputedStyle(resume).outlineStyle,
        actionRowBelowStatus: actionStackRect.top >= statusInfoRect.bottom + 6,
        downloadWidth: downloadRect.width,
        downloadHeight: downloadRect.height,
        downloadAspect: downloadRect.width / downloadRect.height,
        scrollWidth: documentElement.scrollWidth,
        clientWidth: documentElement.clientWidth
      };
    });

    const dark = await inspect();
    assert.equal(dark.statusPhase, true, 'stopped export must own a distinct card phase');
    assert.equal(dark.progressPhase, true, 'stopped export must own a distinct progress phase');
    assert.equal(dark.progressAnimation, 'none', 'stopped progress must remain static');
    assert.equal(dark.progressAfterDisplay, 'none', 'stopped progress must remove active shine');
    assert.equal(dark.stoppedIconIsSvg, true, 'stopped title must use an inline SVG');
    assert.equal(dark.stoppedIconName, 'player-stop',
      'stopped title must use Tabler player-stop');
    assert.notEqual(dark.stoppedIconColor, '', 'stopped SVG must receive a visible theme color');
    assert.equal(dark.resumableCue, true, 'stopped export must show the resumable cue');
    assert.equal(dark.resumableIconName, 'player-play',
      'resumable cue must use Tabler player-play');
    assert.equal(dark.resumeIconName, 'player-play',
      'Resume button must use Tabler player-play');
    assert.equal(dark.resumeTag, 'BUTTON', 'Resume must keep native button semantics');
    assert.equal(dark.resumeText, 'Продолжить',
      'Resume must keep its localized visible accessible label');
    assert.equal(dark.resumeAnimation, 'resumePlayBreathe',
      'the play glyph should breathe when motion is allowed');
    assert.equal(dark.actionRowBelowStatus, true,
      'terminal actions must sit below the status content instead of in a square side column');
    assert(dark.downloadHeight >= 40 && dark.downloadHeight <= 52,
      'Download must keep a compact accessible row height');
    assert(dark.downloadAspect >= 3,
      'a single Download action must be a horizontal button, not a square tile');
    assert(dark.scrollWidth <= dark.clientWidth,
      'stopped status must fit the 350px popup without horizontal overflow');

    await popup.locator('#resumeBtn').focus();
    await popup.keyboard.press('Tab');
    await popup.keyboard.press('Shift+Tab');
    const focusOutline = await popup.locator('#resumeBtn').evaluate(
      element => getComputedStyle(element).outlineStyle
    );
    assert.notEqual(focusOutline, 'none', 'keyboard focus must remain visible on Resume');

    if (process.env.XPORTER_STOPPED_RESUME_SCREENSHOT) {
      await popup.screenshot({
        path: process.env.XPORTER_STOPPED_RESUME_SCREENSHOT,
        fullPage: false
      });
    }

    await popup.evaluate(() => document.body.classList.add('light'));
    const light = await inspect();
    assert.notEqual(light.stoppedIconColor, dark.stoppedIconColor,
      'stopped icon must adapt to the light theme');
    assert(light.scrollWidth <= light.clientWidth,
      'light stopped status must fit the 350px popup');

    await popup.emulateMedia({ reducedMotion: 'reduce' });
    const reducedAnimation = await popup.locator('.resume-play-icon').evaluate(
      element => getComputedStyle(element).animationName
    );
    assert.equal(reducedAnimation, 'none', 'reduced motion must disable Resume breathing');

    await popup.emulateMedia({ reducedMotion: 'no-preference' });
    await popup.evaluate(() => document.body.classList.remove('light'));
    await serviceWorker.evaluate(() => chrome.runtime.sendMessage({
      type: 'EXPORT_STATUS_UPDATE',
      username: 'levelsio',
      exportMode: 'posts',
      running: true,
      status: 'fetching',
      tweetCount: 2010,
      expectedTweets: 3200,
      quantityLimit: 3200,
      batch: 101
    }));
    await popup.locator('#stopBtn').waitFor({ state: 'visible' });
    const running = await popup.evaluate(() => {
      const infoRect = document.querySelector('.status-info').getBoundingClientRect();
      const actionRect = document.getElementById('statusActionStack').getBoundingClientRect();
      const stop = document.getElementById('stopBtn');
      const stopRect = stop.getBoundingClientRect();
      return {
        stopTag: stop.tagName,
        stopText: stop.textContent.trim(),
        actionRowBelowStatus: actionRect.top >= infoRect.bottom + 6,
        stopWidth: stopRect.width,
        stopHeight: stopRect.height,
        alignedToTrailingEdge: Math.abs(actionRect.right - stopRect.right) < 1
      };
    });
    assert.equal(running.stopTag, 'BUTTON', 'Stop must retain native button semantics');
    assert.equal(running.stopText, 'Остановить', 'Stop must retain its localized accessible label');
    assert.equal(running.actionRowBelowStatus, true,
      'Stop must sit below the live status instead of occupying a square side column');
    assert(running.stopHeight >= 40 && running.stopHeight <= 52,
      'Stop must keep a compact accessible row height');
    assert(running.stopWidth >= running.stopHeight * 2,
      'Stop must be a horizontal action, not a square tile');
    assert.equal(running.alignedToTrailingEdge, true,
      'the single running action must align to the logical trailing edge');

    await popup.locator('#stopBtn').focus();
    assert.notEqual(
      await popup.locator('#stopBtn').evaluate(element => getComputedStyle(element).outlineStyle),
      'none',
      'keyboard focus must remain visible on Stop'
    );

    if (process.env.XPORTER_RUNNING_STATUS_SCREENSHOT) {
      await popup.screenshot({
        path: process.env.XPORTER_RUNNING_STATUS_SCREENSHOT,
        fullPage: false
      });
    }

    const localeCodes = ['en', 'ru', 'es', 'de', 'fr', 'pt', 'it', 'tr', 'id', 'hi', 'ja', 'ko', 'zh', 'ar'];
    for (const language of localeCodes) {
      await popup.evaluate(async lang => {
        const stored = await chrome.storage.local.get('xporter_settings');
        await chrome.storage.local.set({
          xporter_settings: { ...(stored.xporter_settings || {}), language: lang }
        });
      }, language);
      await popup.reload({ waitUntil: 'domcontentloaded' });
      await popup.locator('#resumeBtn').waitFor({ state: 'visible' });
      await serviceWorker.evaluate(() => chrome.runtime.sendMessage({
        type: 'EXPORT_STATUS_UPDATE',
        username: 'levelsio',
        exportMode: 'posts',
        running: true,
        status: 'fetching',
        tweetCount: 2010,
        expectedTweets: 3200,
        quantityLimit: 3200,
        batch: 101
      }));
      await popup.locator('#stopBtn').waitFor({ state: 'visible' });
      const localizedRunning = await popup.evaluate(() => {
        const actionRect = document.getElementById('statusActionStack').getBoundingClientRect();
        const stop = document.getElementById('stopBtn');
        const stopRect = stop.getBoundingClientRect();
        const label = stop.querySelector('span');
        const direction = document.documentElement.dir || 'ltr';
        return {
          direction,
          labelFits:
            label.scrollWidth <= label.clientWidth + 1 &&
            label.scrollHeight <= label.clientHeight + 1,
          trailingAligned: direction === 'rtl'
            ? Math.abs(actionRect.left - stopRect.left) < 1
            : Math.abs(actionRect.right - stopRect.right) < 1,
          trailingGap: direction === 'rtl'
            ? Math.abs(actionRect.left - stopRect.left)
            : Math.abs(actionRect.right - stopRect.right),
          actionRect: { left: actionRect.left, right: actionRect.right, width: actionRect.width },
          stopRect: { left: stopRect.left, right: stopRect.right, width: stopRect.width },
          noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth
        };
      });
      assert.equal(localizedRunning.labelFits, true, `${language}: Stop label must fit`);
      assert.equal(localizedRunning.trailingAligned, true,
        `${language}: Stop must align to the logical trailing edge ` +
        `(gap ${localizedRunning.trailingGap}; action ${JSON.stringify(localizedRunning.actionRect)}; ` +
        `stop ${JSON.stringify(localizedRunning.stopRect)})`);
      assert.equal(localizedRunning.noOverflow, true,
        `${language}: running status must not overflow the 350px popup`);
      assert.equal(localizedRunning.direction, language === 'ar' ? 'rtl' : 'ltr',
        `${language}: running status must follow document direction`);
    }

    console.log('Status actions passed 14 locales, stopped/running, dark/light, 350px, focus, and reduced-motion checks.');
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
