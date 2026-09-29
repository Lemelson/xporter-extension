// Legacy counters retain their meaning. Schema-2 diagnostics use new fields.
// Setting this URL sends nothing; Chrome opens it only after removal.
(function () {
    const FEEDBACK_URL_BASE = 'https://lemelson.github.io/xporter-extension/feedback.html';
    let lastRefresh = 0;
    let refreshing = null;
    let requested = false;
    function maybeRefresh(force) {
        if (force || Date.now() - lastRefresh > 20000) return refresh();
    }
    function browserInfo() {
        const nav = globalThis.navigator;
        const brands = nav?.userAgentData?.brands || [];
        const known = brands.find(item => /Microsoft Edge|Google Chrome|Opera/.test(item.brand))
            || brands.find(item => item.brand === 'Chromium');
        const ua = nav?.userAgent || '';
        const family = known?.brand === 'Microsoft Edge' || /Edg\//.test(ua) ? 'edge'
            : known?.brand === 'Opera' || /OPR\//.test(ua) ? 'opera'
            : known?.brand === 'Google Chrome' ? 'chrome' : /Chrom(e|ium)\//.test(ua) ? 'chromium' : 'unknown';
        return { browser_family: family,
            browser_major: Number(known?.version || ua.match(/Chrom(?:e|ium)\/(\d+)/)?.[1]) || null };
    }
    async function snapshot() {
        const [settings, usage] = await Promise.all([XPorterStorage.loadSettings(), XPorterStorage.loadUsage()]);
        const now = Date.now();
        let lang = settings.language;
        if (!lang && typeof detectBrowserLanguage === 'function') {
            try { lang = detectBrowserLanguage(); } catch (_) { /* English fallback */ }
        }
        let os = '';
        try { os = (await chrome.runtime.getPlatformInfo())?.os || ''; } catch (_) { /* unavailable */ }
        const modes = usage.byMode || {};
        const formats = usage.byFormat || {};
        const params = {
            src: 'uninstall', v: chrome.runtime.getManifest().version, os,
            days: usage.installedAt ? Math.floor((now - usage.installedAt) / 86400000) : '',
            installed_at: usage.installedAt ? new Date(usage.installedAt).toISOString() : '',
            ui_lang: lang || 'en', theme: settings.theme || '', opens: usage.opens || 0,
            active_s: Math.round((usage.activeMs || 0) / 1000),
            exp_started: usage.exportsStarted || 0, exp_ok: usage.exportsOk || 0,
            exp_err: usage.exportsErr || 0, exp_stopped: usage.exportsStopped || 0,
            m_posts: modes.posts || 0, m_followers: modes.followers || 0,
            m_following: modes.following || 0, m_verified: modes.verifiedFollowers || 0,
            m_dates: usage.dateRangeExports || 0, resumes: usage.resumes || 0, dl: usage.downloads || 0,
            f_csv: formats.csv || 0, f_json: formats.json || 0, f_xlsx: formats.xlsx || 0,
            items: usage.itemsTotal || 0,
            last_days: usage.lastExportAt ? Math.floor((now - usage.lastExportAt) / 86400000) : '',
            last_err: usage.lastError || '', last_phase: usage.lastPhase || '', first_item_ms: usage.firstItemMs || 0,
            s_retweets: settings.includeRetweets ? 1 : 0, s_replies: settings.includeReplies ? 1 : 0,
            s_articles: settings.includeArticles !== false ? 1 : 0, s_limit: settings.quantityLimit,
            s_localize: settings.localizeExportHeaders ? 1 : 0,
            s_speed: settings.exportSpeed === 'custom' ? `custom_${settings.customDelaySec || 0}` : (settings.exportSpeed || 'standard'),
            s_safety: settings.postSafetyBreakEnabled ? `${settings.postSafetyBreakMin || 0}_${settings.postSafetyBreakEvery || 0}` : 'off',
            s_adaptive: settings.adaptivePacing !== false ? 1 : 0
        };
        // Snapshot the saved current choices, independently of launch-time diagnostics.
        const boolSettings = {
            s_colorful: 'simplifiedDesign', s_ladybug: 'ladybugEnabled', s_auto_expire: 'autoExpireEnabled',
            s_originals: 'includeOriginalPosts', s_quotes: 'includeQuotes',
            s_bookmark_context: 'includeBookmarkReplyContext', s_bookmark_articles: 'includeBookmarkArticles',
            s_post_photos: 'embedPostPhotos', s_bookmark_photos: 'embedBookmarkPhotos', s_about: 'includeAboutAccountDetails'
        };
        for (const [field, key] of Object.entries(boolSettings)) {
            if (typeof settings[key] === 'boolean') params[field] = settings[key] ? 1 : 0;
        }
        const numberSettings = {
            s_window_width: ['popupWidth', 80, 150, 5], s_window_height: ['popupHeight', 50, 100, 5],
            s_element_size: ['uiScale', 80, 130, 5], s_text_size: ['textScale', 80, 130, 5],
            s_auto_expire_hours: ['autoExpireHours', 1, 48, 1],
            s_about_batch: ['aboutAccountCustomBatchSize', 1, 50, 1],
            s_about_retries: ['aboutAccountMaxRetries', 15, 1440, 1]
        };
        for (const [field, [key, min, max, step]] of Object.entries(numberSettings)) {
            const value = settings[key];
            if (Number.isFinite(value) && value >= min && value <= max && value % step === 0) params[field] = value;
        }
        const choices = {
            s_mode: ['exportMode', ['posts', 'bookmarks', 'followers', 'following', 'verified_followers', 'seen_posts']],
            s_format: ['outputFormat', ['csv', 'json', 'xlsx', 'txt', 'pdf']],
            s_about_speed: ['aboutAccountSpeed', ['turbo', 'fast', 'standard', 'careful', 'turtle', 'custom']]
        };
        for (const [field, [key, allowed]] of Object.entries(choices)) {
            if (allowed.includes(settings[key])) params[field] = settings[key];
        }
        // Use the same fallback as the theme picker for older saved settings.
        if (globalThis.XPorterThemes) params.theme_preset = XPorterThemes.resolve(settings).id;
        params.f_txt = formats.txt || 0;
        params.f_pdf = formats.pdf || 0;
        params.ladybug_squashes = usage.ladybugSquashes || 0;
        // These counters begin at an explicit observation baseline; absence in
        // older installations is unknown rather than zero lifetime activity.
        const ui = usage.uiDiagnostics;
        if (ui?.version === 1 && Number.isFinite(ui.since) && ui.since > 0) {
            params.ui_diag_version = 1;
            params.ui_diag_since = new Date(ui.since).toISOString();
            const uiFields = { ui_start_clicks:'startClicks', ui_start_sent:'startSent', ui_start_accepted:'startAccepted',
                ui_start_invalid:'startInvalid', ui_start_worker_error:'startWorkerError', ui_no_session_views:'noSessionViews',
                ui_status_read_errors:'statusReadErrors', ui_theme_changes:'themeChanges', ui_speed_changes:'speedChanges',
                ui_settings_views:'settingsViews', ui_about_views:'aboutViews' };
            for (const [field, key] of Object.entries(uiFields)) {
                if (Number.isSafeInteger(ui[key]) && ui[key] >= 0 && ui[key] <= 1e12) params[field] = ui[key];
            }
        }
        if (usage.installedAtApprox) params.inst_approx = 1;
        if (globalThis.XPorterDiagnostics) {
            const diagnostics = await XPorterDiagnostics.load();
            Object.assign(params, browserInfo(), {
                schema_version: 2, schema_since: new Date(diagnostics.since).toISOString(),
                snapshot_at: new Date(now).toISOString(), install_id: diagnostics.installId,
                install_v: usage.installVersion || '', m_bookmarks: modes.bookmarks || 0,
                s_user_speed: settings.userExportSpeed === 'custom' ? `custom_${settings.userCustomDelaySec || 0}` : (settings.userExportSpeed || 'standard'),
                s_user_safety: settings.userSafetyBreakEnabled ? `${settings.userSafetyBreakMin || 0}_${settings.userSafetyBreakEvery || 0}` : 'off',
                diag_historical: diagnostics.historical ? 1 : 0, diag_active_days: diagnostics.activeDays,
                diag_first_attempt_ms: diagnostics.firstAttemptMs, diag_first_start_ms: diagnostics.firstStartMs,
                diag_first_item_ms: diagnostics.firstItemMs, diag_first_download_ms: diagnostics.firstDownloadMs,
                diag_attempts: diagnostics.attempts, diag_downloads: diagnostics.downloads,
                diag_totals: diagnostics.totals, diag_revision: diagnostics.revision
            });
        }
        return params;
    }
    function refresh() {
        requested = true;
        if (refreshing) return refreshing;
        refreshing = (async () => {
            while (requested) {
                requested = false; lastRefresh = Date.now();
                try {
                    const params = await snapshot();
                    const url = globalThis.XPorterDiagnosticsCodec
                        ? await XPorterDiagnosticsCodec.buildURL(FEEDBACK_URL_BASE, params)
                        : `${FEEDBACK_URL_BASE}?${Object.entries(params)
                            .filter(([, value]) => value !== '' && value !== undefined && value !== null)
                            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
                    await chrome.runtime.setUninstallURL(url);
                } catch (_) {
                    try { await chrome.runtime.setUninstallURL(`${FEEDBACK_URL_BASE}?src=uninstall&transport_error=1`); }
                    catch (_) { /* diagnostics must never break exports */ }
                }
            }
        })().finally(() => { refreshing = null; });
        return refreshing;
    }
    chrome.runtime.onInstalled.addListener(async details => {
        if (details.reason === 'install') await XPorterStorage.markInstalled(chrome.runtime.getManifest().version);
        else if (details.reason === 'update') await XPorterStorage.backfillInstalledAt();
        await refresh();
    });
    chrome.runtime.onStartup.addListener(refresh);
    globalThis.XPorterFeedback = { refresh, maybeRefresh, snapshot };
})();
