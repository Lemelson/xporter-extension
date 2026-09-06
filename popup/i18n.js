// XPorter — i18n Module
// Loads translations from per-language JSON files in locales/
// Falls back to English for any missing keys

// English is pinned first because it is the default/fallback UI language.
// The remaining order is presentation-only; 'en' stays the hard-coded fallback.
const LANGUAGES = [
    { code: 'en', flag: '🇺🇸', name: 'English' },
    { code: 'zh', flag: '🇨🇳', name: '中文' },
    { code: 'ja', flag: '🇯🇵', name: '日本語' },
    { code: 'es', flag: '🇪🇸', name: 'Español' },
    { code: 'ko', flag: '🇰🇷', name: '한국어' },
    { code: 'ru', flag: '🇷🇺', name: 'Русский' },
    { code: 'it', flag: '🇮🇹', name: 'Italiano' },
    { code: 'pt', flag: '🇧🇷', name: 'Português' },
    { code: 'tr', flag: '🇹🇷', name: 'Türkçe' },
    { code: 'de', flag: '🇩🇪', name: 'Deutsch' },
    { code: 'ar', flag: '🇸🇦', name: 'العربية' },
    { code: 'fr', flag: '🇫🇷', name: 'Français' },
    { code: 'hi', flag: '🇮🇳', name: 'हिन्दी' },
    { code: 'id', flag: '🇮🇩', name: 'Bahasa Indonesia' },
];

/**
 * Detect Chrome's UI language and map to a supported language code.
 * Falls back to 'en' if the browser language is not in LANGUAGES.
 */
function detectBrowserLanguage() {
    const uiLang = chrome.i18n.getUILanguage(); // e.g. "en-US", "ru", "zh-CN"
    const base = uiLang.split('-')[0].toLowerCase(); // e.g. "en", "ru", "zh"
    return LANGUAGES.find(l => l.code === base) ? base : 'en';
}

// One promise per locale owns both in-flight and completed loads. English uses
// this same path, so concurrent locale/fallback requests cannot fetch it twice.
const _loadedLocales = new Map();

function _loadLocale(langCode) {
    if (!_loadedLocales.has(langCode)) {
        const request = (async () => {
            const url = chrome.runtime.getURL(`popup/locales/${langCode}.json`);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        })().catch(error => {
            _loadedLocales.delete(langCode); // retry transient failures next time
            console.warn(`[i18n] Failed to load locale "${langCode}":`, error.message);
            return null;
        });
        _loadedLocales.set(langCode, request);
    }
    return _loadedLocales.get(langCode);
}

// ==================== Public API ====================

/**
 * Load translations for a language and return a merged object
 * with English fallback for any missing keys.
 *
 * @param {string} langCode - Language code
 * @returns {Promise<Object>} Complete translations (lang + fallback)
 */
async function loadTranslations(langCode) {
    const [locale, fallback] = await Promise.all([
        _loadLocale(langCode),
        _loadLocale('en')
    ]);

    // Merge: current language overrides English defaults
    const merged = { ...fallback, ...(locale || {}) };
    return merged;
}
