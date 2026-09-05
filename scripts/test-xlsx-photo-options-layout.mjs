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

function relativeLuminance(rgb) {
  const channels = rgb.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(value => Number(value) / 255);
  const [red, green, blue] = channels.map(value =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

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
    await serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.local.get('xporter_settings');
      await chrome.storage.local.set({
        xporter_settings: {
          ...(stored.xporter_settings || {}),
          exportMode: 'posts',
          outputFormat: 'xlsx'
        }
      });
    });
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 350, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });

    for (const language of LOCALES) {
      await popup.evaluate(async (lang) => {
        const stored = await chrome.storage.local.get('xporter_settings');
        await chrome.storage.local.set({
          xporter_settings: { ...(stored.xporter_settings || {}), language: lang }
        });
      }, language);
      await popup.reload({ waitUntil: 'domcontentloaded' });

      const postPanel = popup.locator('#postSelectionPanel');
      await postPanel.waitFor({ state: 'visible' });
      const panel = popup.locator('#xlsxPhotoOptions');
      await panel.waitFor({ state: 'visible' });

      const firstPostCheckbox = postPanel.locator('.post-type-choice input').first();
      const wasChecked = await firstPostCheckbox.isChecked();
      await firstPostCheckbox.focus();
      await popup.keyboard.press('Space');
      assert.notEqual(await firstPostCheckbox.isChecked(), wasChecked,
        `${language}: Space must toggle a focused post-type checkbox`);
      await popup.keyboard.press('Space');
      assert.equal(await firstPostCheckbox.isChecked(), wasChecked,
        `${language}: Space must restore a focused post-type checkbox`);

      const postLayout = await postPanel.evaluate(element => {
        const choices = [...element.querySelectorAll('.post-type-choice')];
        const icons = [...element.querySelectorAll('[data-post-type-icon]')];
        const firstChoice = choices[0];
        const firstInput = firstChoice.querySelector('input');
        const firstIcon = firstChoice.querySelector('[data-post-type-icon]');
        const firstCheck = firstChoice.querySelector('.post-choice-check');
        firstChoice.style.transition = 'none';
        firstInput.focus();
        const focusedChoiceOutline = getComputedStyle(firstChoice).outlineWidth;
        const focusedCheckOutline = getComputedStyle(firstCheck).outlineWidth;
        const firstChoiceRect = firstChoice.getBoundingClientRect();
        const firstIconRect = firstIcon.getBoundingClientRect();
        const firstCheckRect = firstCheck.getBoundingClientRect();
        const checkedBackground = getComputedStyle(firstChoice).backgroundColor;
        const checkedIconOpacity = Number(getComputedStyle(firstIcon).opacity);
        firstInput.checked = false;
        const uncheckedBackground = getComputedStyle(firstChoice).backgroundColor;
        const uncheckedIconOpacity = Number(getComputedStyle(firstIcon).opacity);
        firstInput.checked = true;
        return {
          choiceCount: choices.length,
          iconCount: icons.length,
          iconTypes: icons.map(icon => icon.dataset.postTypeIcon),
          tablerNames: icons.map(icon => icon.querySelector('svg')?.dataset.tablerIcon || ''),
          iconColors: icons.map(icon => getComputedStyle(icon).color),
          focusedChoiceOutline,
          focusedCheckOutline,
          checkedBackground,
          uncheckedBackground,
          checkedIconOpacity,
          uncheckedIconOpacity,
          firstChoiceRect: {
            left: firstChoiceRect.left,
            right: firstChoiceRect.right
          },
          firstIconRect: {
            left: firstIconRect.left,
            right: firstIconRect.right
          },
          firstCheckRect: {
            left: firstCheckRect.left,
            right: firstCheckRect.right
          },
          icons: icons.map(icon => {
            const style = getComputedStyle(icon);
            const rect = icon.getBoundingClientRect();
            return {
              hasSvg: Boolean(icon.querySelector('svg')),
              width: rect.width,
              height: rect.height,
              background: style.backgroundColor,
              borderStyle: style.borderStyle
            };
          }),
          choices: choices.map(choice => ({
            clientWidth: choice.clientWidth,
            scrollWidth: choice.scrollWidth,
            clientHeight: choice.clientHeight,
            scrollHeight: choice.scrollHeight
          }))
        };
      });
      const layout = await panel.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const choices = [...element.querySelectorAll('.xlsx-photo-choice')];
        const icons = [...element.querySelectorAll('[data-xlsx-photo-icon]')];
        const inputs = [...element.querySelectorAll('input')];
        const recommendedBadge = element.querySelector('.xlsx-photo-recommended-badge');
        const hadLightClass = document.body.classList.contains('light');
        document.body.classList.remove('light');
        const recommendedStyle = recommendedBadge
          ? getComputedStyle(recommendedBadge)
          : null;
        const recommendedDarkAppearance = recommendedStyle
          ? { color: recommendedStyle.color, background: recommendedStyle.backgroundColor }
          : null;
        document.body.classList.add('light');
        const recommendedLightStyle = recommendedBadge
          ? getComputedStyle(recommendedBadge)
          : null;
        const recommendedLightAppearance = recommendedLightStyle
          ? { color: recommendedLightStyle.color, background: recommendedLightStyle.backgroundColor }
          : null;
        document.body.classList.toggle('light', hadLightClass);
        return {
          title: element.querySelector('#xlsxPhotosTitle')?.textContent.trim() || '',
          recommendedText: recommendedBadge?.textContent.trim() || '',
          recommendedBackground: recommendedStyle?.backgroundColor || '',
          recommendedDarkAppearance,
          recommendedLightAppearance,
          rect: { left: rect.left, right: rect.right, width: rect.width },
          viewportWidth: window.innerWidth,
          direction: document.documentElement.dir || 'ltr',
          choiceCount: choices.length,
          inputTypes: inputs.map(input => input.type),
          inputNames: inputs.map(input => input.name),
          iconCount: icons.length,
          iconTypes: icons.map(icon => icon.dataset.xlsxPhotoIcon),
          icons: icons.map(icon => {
            const style = getComputedStyle(icon);
            const rect = icon.getBoundingClientRect();
            const svgRect = icon.querySelector('svg').getBoundingClientRect();
            return {
              hasSvg: Boolean(icon.querySelector('svg')),
              width: rect.width,
              height: rect.height,
              background: style.backgroundColor,
              borderStyle: style.borderStyle,
              color: style.color,
              svgInsideIcon:
                svgRect.left >= rect.left &&
                svgRect.right <= rect.right &&
                svgRect.top >= rect.top &&
                svgRect.bottom <= rect.bottom
            };
          }),
          choices: choices.map(choice => ({
            clientWidth: choice.clientWidth,
            scrollWidth: choice.scrollWidth,
            clientHeight: choice.clientHeight,
            scrollHeight: choice.scrollHeight
          }))
        };
      });

      assert.equal(postLayout.choiceCount, 5,
        `${language}: all five post-type choices must remain visible`);
      assert.equal(postLayout.iconCount, 5,
        `${language}: every post type must have one explanatory icon`);
      assert.deepEqual(
        postLayout.iconTypes,
        ['original', 'quote', 'reply', 'repost', 'article'],
        `${language}: post-type icons must keep a stable semantic order`
      );
      assert.deepEqual(
        postLayout.tablerNames,
        ['pencil', 'quote', 'message-reply', 'repeat', 'article'],
        `${language}: post-type cards must use the approved official Tabler icon set`
      );
      assert.equal(new Set(postLayout.iconColors).size, 5,
        `${language}: every post type must keep its own identifying color`);
      assert.equal(postLayout.focusedChoiceOutline, '2px',
        `${language}: keyboard focus must outline the full post-type card`);
      assert.equal(postLayout.focusedCheckOutline, '2px',
        `${language}: keyboard focus must also identify the checkbox`);
      assert.notEqual(postLayout.checkedBackground, postLayout.uncheckedBackground,
        `${language}: checked state must be visible beyond the checkbox`);
      assert(postLayout.checkedIconOpacity > postLayout.uncheckedIconOpacity,
        `${language}: icon opacity must reinforce checked state without relying on color alone`);
      if (language === 'ar') {
        assert(postLayout.firstIconRect.right > postLayout.firstCheckRect.right,
          `${language}: RTL must place the semantic icon at the leading edge`);
      } else {
        assert(postLayout.firstIconRect.left < postLayout.firstCheckRect.left,
          `${language}: LTR must place the semantic icon at the leading edge`);
      }
      for (const [index, icon] of postLayout.icons.entries()) {
        assert.equal(icon.hasSvg, true, `${language}: icon ${index + 1} must be inline SVG`);
        assert(icon.width >= 24 && icon.height >= 24,
          `${language}: icon ${index + 1} must be large enough to identify`);
        assert.equal(icon.background, 'rgba(0, 0, 0, 0)',
          `${language}: icon ${index + 1} must not sit inside a colored square`);
        assert.equal(icon.borderStyle, 'none',
          `${language}: icon ${index + 1} must not have a boxed outline`);
      }
      for (const [index, choice] of postLayout.choices.entries()) {
        assert(choice.scrollWidth <= choice.clientWidth + 1,
          `${language}: post choice ${index + 1} overflows horizontally`);
        assert(choice.scrollHeight <= choice.clientHeight + 1,
          `${language}: post choice ${index + 1} clips translated text`);
      }
      if (process.env.XPORTER_POST_TYPES_ONLY === '1') {
        if (language === 'ru' && process.env.XPORTER_POST_TYPE_ICONS_SCREENSHOT) {
          await postPanel.scrollIntoViewIfNeeded();
          await popup.screenshot({
            path: process.env.XPORTER_POST_TYPE_ICONS_SCREENSHOT,
            fullPage: false
          });
        }
        continue;
      }
      assert(layout.title.length > 0, `${language}: photo-mode heading must be localized`);
      assert(layout.recommendedText.length > 0,
        `${language}: links-only choice must show a localized Recommended badge`);
      assert.notEqual(layout.recommendedBackground, 'rgba(0, 0, 0, 0)',
        `${language}: Recommended badge must have a visible background`);
      for (const [appearance, colors] of Object.entries({
        dark: layout.recommendedDarkAppearance,
        light: layout.recommendedLightAppearance
      })) {
        assert(relativeLuminance(colors.color) < relativeLuminance(colors.background),
          `${language}: ${appearance} Recommended badge must use dark text on yellow (${colors.color} on ${colors.background})`);
        assert(contrastRatio(colors.color, colors.background) >= 4.5,
          `${language}: ${appearance} Recommended badge must meet 4.5:1 WCAG contrast (${colors.color} on ${colors.background})`);
      }
      assert.equal(layout.choiceCount, 2, `${language}: links and previews must both be visible`);
      assert.deepEqual(layout.inputTypes, ['radio', 'radio'],
        `${language}: photo modes must preserve native radio semantics`);
      assert.deepEqual(layout.inputNames, ['xlsxPhotoMode', 'xlsxPhotoMode'],
        `${language}: photo modes must remain one mutually exclusive native group`);
      assert.equal(layout.iconCount, 2,
        `${language}: each photo choice must have one explanatory icon`);
      assert.deepEqual(layout.iconTypes, ['links', 'embed'],
        `${language}: photo-choice icons must keep a stable semantic order`);
      assert.notEqual(layout.icons[0].color, layout.icons[1].color,
        `${language}: links and previews must use distinct icon colors`);
      for (const [index, icon] of layout.icons.entries()) {
        assert.equal(icon.hasSvg, true, `${language}: photo icon ${index + 1} must be inline SVG`);
        assert(icon.width >= 27.99 && icon.height >= 27.99,
          `${language}: photo icon ${index + 1} must be large enough to identify (${icon.width}x${icon.height})`);
        assert.equal(icon.background, 'rgba(0, 0, 0, 0)',
          `${language}: photo icon ${index + 1} must not sit inside a colored square`);
        assert.equal(icon.borderStyle, 'none',
          `${language}: photo icon ${index + 1} must not have a boxed outline`);
        assert.equal(icon.svgInsideIcon, true,
          `${language}: photo icon ${index + 1} must remain fully inside its layout box`);
      }
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

      await popup.locator('#xlsxPhotoLinks').focus();
      await popup.keyboard.press('ArrowDown');
      assert.equal(await popup.locator('#xlsxPhotoEmbed').isChecked(), true,
        `${language}: keyboard arrows must move the native radio selection`);
      await popup.locator('#photoPermissionDialog').waitFor({ state: 'visible' });
      await popup.locator('#photoPermissionCancel').click();
      assert.equal(await popup.locator('#xlsxPhotoLinks').isChecked(), true,
        `${language}: cancelling optional photo access must restore the links radio`);

      if (language === 'ru' && process.env.XPORTER_POST_TYPE_ICONS_SCREENSHOT) {
        await postPanel.scrollIntoViewIfNeeded();
        await popup.screenshot({
          path: process.env.XPORTER_POST_TYPE_ICONS_SCREENSHOT,
          fullPage: false
        });
      }
      if (language === 'ru' && process.env.XPORTER_XLSX_PHOTO_OPTIONS_SCREENSHOT) {
        await panel.scrollIntoViewIfNeeded();
        await popup.screenshot({
          path: process.env.XPORTER_XLSX_PHOTO_OPTIONS_SCREENSHOT,
          fullPage: false
        });
      }
    }

    if (process.env.XPORTER_POST_TYPES_ONLY === '1') {
      console.log(`Tabler post-type cards fit and remain operable in ${LOCALES.length} locales.`);
    } else {
      console.log(`XLSX photo choices fit without clipping in ${LOCALES.length} locales.`);
    }
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
