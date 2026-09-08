// Extension language wins; browser languages are only a fallback. The site
// uses regional keys for Simplified Chinese and Brazilian Portuguese.
(function () {
    const supported = ['en','zh_CN','ja','es','ko','ru','it','pt_BR','tr','de','ar','fr','hi','id'];
    function normalize(value) {
        if (typeof value !== 'string') return null;
        const base = value.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
        const key = base === 'zh' ? 'zh_CN' : base === 'pt' ? 'pt_BR' : base;
        return supported.includes(key) ? key : null;
    }
    function choose(extensionLanguage, browserLanguages) {
        const explicit = normalize(extensionLanguage);
        if (explicit) return { language: explicit, source: 'extension' };
        for (const language of browserLanguages || []) {
            const normalized = normalize(language);
            if (normalized) return { language: normalized, source: 'browser' };
        }
        return { language: 'en', source: 'fallback' };
    }
    globalThis.XPorterFeedbackLanguage = { supported, normalize, choose };
})();
