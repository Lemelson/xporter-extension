// XPorter — uninstall feedback module
// Builds the privacy-reviewed anonymous usage snapshot and keeps Chrome's
// uninstall URL current without leaking export contents or usernames.

(function () {
    const FEEDBACK_URL_BASE = 'https://lemelson.github.io/xporter/feedback.html';
    let lastRefresh = 0;

    function maybeRefresh(force) {
        const now = Date.now();
        if (force || now - lastRefresh > 20000) refresh();
    }

    async function refresh() {
        lastRefresh = Date.now();
        try {
            const [settings, usage] = await Promise.all([
                XPorterStorage.loadSettings(),
                XPorterStorage.loadUsage()
            ]);
            const now = Date.now();
            const days = usage.installedAt ? Math.floor((now - usage.installedAt) / 86400000) : '';
            const lastDays = usage.lastExportAt ? Math.floor((now - usage.lastExportAt) / 86400000) : '';
            let lang = settings.language;
            if (!lang && typeof detectBrowserLanguage === 'function') {
                try { lang = detectBrowserLanguage(); } catch (_) { /* use English */ }
            }
            let os = '';
            try {
                const platform = await chrome.runtime.getPlatformInfo();
                os = platform?.os || '';
            } catch (_) { /* omit platform */ }

            const modes = usage.byMode || {};
            const formats = usage.byFormat || {};
            const params = {
                src: 'uninstall',
                v: chrome.runtime.getManifest().version,
                os,
                days,
                installed_at: usage.installedAt ? new Date(usage.installedAt).toISOString() : '',
                ui_lang: lang || 'en',
                theme: settings.theme || '',
                opens: usage.opens || 0,
                active_s: Math.round((usage.activeMs || 0) / 1000),
                exp_started: usage.exportsStarted || 0,
                exp_ok: usage.exportsOk || 0,
                exp_err: usage.exportsErr || 0,
                exp_stopped: usage.exportsStopped || 0,
                m_posts: modes.posts || 0,
                m_followers: modes.followers || 0,
                m_following: modes.following || 0,
                m_verified: modes.verifiedFollowers || 0,
                m_dates: usage.dateRangeExports || 0,
                resumes: usage.resumes || 0,
                dl: usage.downloads || 0,
                f_csv: formats.csv || 0,
                f_json: formats.json || 0,
                f_xlsx: formats.xlsx || 0,
                items: usage.itemsTotal || 0,
                last_days: lastDays,
                last_err: usage.lastError || '',
                last_phase: usage.lastPhase || '',
                first_item_ms: usage.firstItemMs || 0,
                s_retweets: settings.includeRetweets ? 1 : 0,
                s_replies: settings.includeReplies ? 1 : 0,
                s_articles: settings.includeArticles !== false ? 1 : 0,
                s_limit: settings.quantityLimit,
                s_localize: settings.localizeExportHeaders ? 1 : 0,
                s_speed: settings.exportSpeed === 'custom'
                    ? `custom_${settings.customDelaySec || 0}_${settings.customCooldownMin || 0}_${settings.customBatchSize || 0}`
                    : (settings.exportSpeed || 'standard'),
                s_adaptive: settings.adaptivePacing !== false ? 1 : 0
            };
            if (usage.installedAtApprox) params.inst_approx = 1;
            const query = Object.entries(params)
                .filter(([, value]) => value !== '' && value !== undefined && value !== null)
                .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
                .join('&');
            chrome.runtime.setUninstallURL(`${FEEDBACK_URL_BASE}?${query}`);
        } catch (_) {
            try {
                chrome.runtime.setUninstallURL(`${FEEDBACK_URL_BASE}?src=uninstall`);
            } catch (_) { /* best effort */ }
        }
    }

    chrome.runtime.onInstalled.addListener(async (details) => {
        if (details.reason === 'install') {
            await XPorterStorage.markInstalled(chrome.runtime.getManifest().version);
        } else if (details.reason === 'update') {
            await XPorterStorage.backfillInstalledAt();
        }
        refresh();
    });
    chrome.runtime.onStartup.addListener(refresh);

    globalThis.XPorterFeedback = { refresh, maybeRefresh };
})();
