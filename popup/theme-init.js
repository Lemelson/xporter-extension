// Shared appearance policy. The legacy simplifiedDesign storage flag now enables
// optional colorful styling; false/default selects the neutral surfaces.
(function (root) {
    'use strict';
    const scales = Object.freeze([80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130]);
    const textScales = Object.freeze([80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130]);
    function stepped(value, min, max) {
        const number = Number(value);
        return Number.isFinite(number) && number >= min && number <= max && number % 5 === 0 ? number : 100;
    }
    function normalize(settings = {}) {
        const requestedScale = Number(settings.uiScale);
        return {
            simplifiedDesign: settings.simplifiedDesign === true,
            uiScale: scales.includes(requestedScale) ? requestedScale : 100,
            popupWidth: stepped(settings.popupWidth, 80, 150),
            popupHeight: stepped(settings.popupHeight, 50, 100),
            textScale: textScales.includes(Number(settings.textScale)) ? Number(settings.textScale) : 100
        };
    }
    function apply(element, settings) {
        const appearance = normalize(settings);
        XPorterThemes.apply(element, settings);
        element.style.setProperty('--ui-scale', String(appearance.uiScale / 100));
        element.style.setProperty('--text-scale', String((100 + (appearance.textScale - 100) * 3 / 5) / appearance.uiScale));
        element.style.setProperty('--popup-width', String(appearance.popupWidth / 100));
        element.style.setProperty('--popup-height', String(appearance.popupHeight / 100));

        return appearance;
    }
    root.XPorterUIAppearance = Object.freeze({ scales, textScales, normalize, apply });
})(globalThis);

// Early theme apply — read storage directly (no IPC) to prevent FOUC.
// Must run before body content renders.
// Native action windows measure their own preferred size. Constraining that
// size to their initial viewport creates a shrinking feedback loop. Ordinary
// tabs/previews still need responsive viewport bounds.
// The legacy chrome.extension namespace is guarded: a failure here must not
// skip appearance and theme application for the whole session.
let isActionView = false;
try {
    isActionView = chrome.extension?.getViews({ type: 'popup' })?.includes(window) === true;
} catch (_) { /* not an action view */ }
document.documentElement.classList.toggle('action-popup', isActionView);
XPorterUIAppearance.apply(document.body, {});
chrome.storage.local.get('xporter_settings', (r) => {
  // apply() also applies the theme preset (XPorterThemes.apply).
  XPorterUIAppearance.apply(document.body, r.xporter_settings || {});
});

// Native selects can retain :focus-visible after mouse selection on macOS.
// Track input modality without blurring the control or breaking arrow keys.
document.addEventListener('pointerdown', () => {
    document.body.dataset.inputModality = 'pointer';
}, true);
document.addEventListener('keydown', event => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey &&
        !['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
        document.body.dataset.inputModality = 'keyboard';
    }
}, true);
