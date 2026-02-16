// XPorter — i18n Module
// Loads translations from per-language JSON files in locales/
// Falls back to English for any missing keys

const LANGUAGES = [
    { code: 'en', flag: '🇺🇸', name: 'English' },
    { code: 'es', flag: '🇪🇸', name: 'Español' },
    { code: 'pt', flag: '🇧🇷', name: 'Português' },
    { code: 'hi', flag: '🇮🇳', name: 'हिन्दी' },
    { code: 'zh', flag: '🇨🇳', name: '中文' },
    { code: 'ru', flag: '🇷🇺', name: 'Русский' },
    { code: 'ar', flag: '🇸🇦', name: 'العربية' },
    { code: 'fr', flag: '🇫🇷', name: 'Français' },
    { code: 'de', flag: '🇩🇪', name: 'Deutsch' },
    { code: 'ja', flag: '🇯🇵', name: '日本語' },
    { code: 'ko', flag: '🇰🇷', name: '한국어' },
    { code: 'tr', flag: '🇹🇷', name: 'Türkçe' },
    { code: 'id', flag: '🇮🇩', name: 'Bahasa Indonesia' },
    { code: 'it', flag: '🇮🇹', name: 'Italiano' },
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

// ==================== Translation Cache ====================
// Loaded translations are cached to avoid re-fetching
const _loadedLocales = {};
let _fallbackLocale = null; // English, loaded once

/**
 * Load a locale JSON file and cache it.
 * @param {string} langCode - Language code (e.g. 'en', 'ru')
 * @returns {Promise<Object>} Parsed translation object
 */
async function _loadLocale(langCode) {
    if (_loadedLocales[langCode]) {
        return _loadedLocales[langCode];
    }
    try {
        const url = chrome.runtime.getURL(`popup/locales/${langCode}.json`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        _loadedLocales[langCode] = data;
        return data;
    } catch (e) {
        console.warn(`[i18n] Failed to load locale "${langCode}":`, e.message);
        return null;
    }
}

/**
 * Ensure English fallback locale is loaded.
 */
async function _ensureFallback() {
    if (!_fallbackLocale) {
        _fallbackLocale = await _loadLocale('en');
    }
    return _fallbackLocale;
}

// ==================== Public API ====================

/**
 * Get a translation string with fallback chain:
 *   1. Current language
 *   2. English fallback
 *   3. Raw key name
 *
 * @param {string} key - Translation key
 * @param {Object} [currentTranslations] - Pre-loaded translations for current language
 * @returns {string} Translated string
 */
function t(key, currentTranslations) {
    // Try current language
    if (currentTranslations && currentTranslations[key] !== undefined) {
        return currentTranslations[key];
    }
    // Try English fallback
    if (_fallbackLocale && _fallbackLocale[key] !== undefined) {
        return _fallbackLocale[key];
    }
    // Last resort: return the key itself
    return key;
}

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
        _ensureFallback()
    ]);

    // Merge: current language overrides English defaults
    const merged = { ...fallback, ...(locale || {}) };
    return merged;
}

// ==================== TRANSLATIONS (backward compat) ====================
// Provide a synchronous TRANSLATIONS object for existing code that
// accesses TRANSLATIONS[lang][key]. Populated lazily as locales load.
const TRANSLATIONS = new Proxy({}, {
    get(target, langCode) {
        // Return cached locale if available, otherwise empty object
        // that will be populated when loadTranslations() is called
        return _loadedLocales[langCode] || {};
    }
});
