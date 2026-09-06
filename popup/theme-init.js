// Shared appearance policy. One UI, with optional simplified surfaces and zoom.
(function (root) {
    'use strict';
    const scales = Object.freeze([85, 100, 115, 130]);
    function normalize(settings = {}) {
        const requestedScale = Number(settings.uiScale);
        return {
            simplifiedDesign: settings.simplifiedDesign === true,
            uiScale: scales.includes(requestedScale) ? requestedScale : 100
        };
    }
    function apply(element, settings) {
        const appearance = normalize(settings);
        element.classList.toggle('simplified', appearance.simplifiedDesign);
        element.style.setProperty('--ui-scale', String(appearance.uiScale / 100));
        return appearance;
    }
    root.XPorterUIAppearance = Object.freeze({ scales, normalize, apply });
})(globalThis);

// Early theme apply — read storage directly (no IPC) to prevent FOUC.
// Must run before body content renders.
XPorterUIAppearance.apply(document.body, {});
chrome.storage.local.get('xporter_settings', (r) => {
  XPorterUIAppearance.apply(document.body, r.xporter_settings || {});
  if (r.xporter_settings?.theme === 'light') document.body.classList.add('light');
});
