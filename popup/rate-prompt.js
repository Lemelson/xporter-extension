// XPorter — Rate Prompt
// A self-contained "Enjoying XPorter? leave a review" overlay, shared by the
// popup and the full-page export UI. State lives directly in
// chrome.storage.local (no new service-worker message types). Strings come
// from popup/locales/*.json via the page's loaded translations, with an
// English fallback baked in so the overlay always renders something readable.
//
// NOTE on detecting real ratings: the Chrome Web Store gives us NO way to know
// whether a user actually left a review — only that they clicked our button.
// So "clicked Rate" is treated as rated (we stop asking).
//
// Public API (window.XPorterRatePrompt):
//   maybeShow({ translations, onReportBug })  — show only if gating passes
//   incrementExports()                        — call once per completed export
//   rateNow()                                 — open store + mark rated (no UI)
(function () {
    'use strict';

    const CONFIG = {
        // Deep-link straight to the Chrome Web Store reviews section.
        STORE_URL: 'https://chromewebstore.google.com/detail/jghmghialodmkmbcpfnhkgllkmjafmja/reviews',
        // Where "Report a problem" sends users on the export page (the popup
        // instead switches to its About tab — see export.js / popup.js).
        BUG_URL: 'https://t.me/Lemelson',
        STORAGE_KEY: 'xporter_rate_prompt',

        // First ask: after this many completed exports since install.
        INITIAL_EXPORTS: 5,
        // Days to wait before the 2nd, 3rd and 4th prompt — one entry per
        // deferral, each also requires at least one new export since deferring.
        // Schedule grows so we ask less and less often.
        REASK_SCHEDULE_DAYS: [14, 30, 30],
        // Hard cap: after this many "Maybe later" deferrals we never ask again.
        // (= the maximum number of times the prompt is ever shown.)
        MAX_DEFERS: 4,
    };

    const DAY = 86400000;

    // English fallback for the overlay strings (locale files override these).
    const EN = {
        rateTitle: 'Enjoying XPorter?',
        rateBody: "XPorter is **free** and **unlimited**. I'm always adding new features and fixing bugs. If it's helping you, please leave **5 stars**. It really supports the project and helps others find it.",
        rateCta: 'Rate on the Web Store',
        rateLater: 'Maybe later',
        rateReport: 'Report a problem',
        rateClose: 'Close',
        rateThanks: 'Thank you!'
    };

    const STAR_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4l2.95 5.98 6.6.96-4.77 4.65 1.13 6.57L12 17.94l-5.91 3.11 1.13-6.57-4.77-4.65 6.6-.96z"/></svg>';
    const X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    const HEART_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.8 5.1a5.4 5.4 0 0 0-7.7 0l-1.1 1.1-1.1-1.1a5.4 5.4 0 1 0-7.7 7.7l1.1 1.1 7.7 7.6 7.7-7.6 1.1-1.1a5.4 5.4 0 0 0 0-7.7z"/></svg>';

    let activeOverlay = null;

    // ==================== Storage ====================
    async function loadState() {
        let stored = {};
        try {
            const r = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
            stored = r[CONFIG.STORAGE_KEY] || {};
        } catch (_) { stored = {}; }

        const state = Object.assign(
            {
                status: 'pending', exports: 0, firstSeen: 0,
                deferCount: 0, lastDeferAt: 0, exportsAtDefer: 0, lastShownAt: 0,
                lastCountedExportKey: ''
            },
            stored
        );
        if (!state.firstSeen) {
            state.firstSeen = Date.now();
            await saveState(state);
        }
        return state;
    }

    async function saveState(state) {
        try {
            await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: state });
        } catch (_) { /* ignore quota / context errors */ }
    }

    async function patchState(patch) {
        const next = Object.assign(await loadState(), patch);
        await saveState(next);
        return next;
    }

    // ==================== Gating ====================
    // Evaluated at a "successful download" moment.
    // Schedule: 1st prompt after INITIAL_EXPORTS exports; then on each "Maybe
    // later" we wait a growing window (14 → 30 → 30 days) AND require at least
    // one new export before re-asking. After MAX_DEFERS deferrals (or any
    // "Rate"), we stop forever. So a non-rater sees the prompt at most 4 times.
    function ready(state) {
        if (state.status === 'rated' || state.status === 'dismissed') return false;

        const defers = state.deferCount || 0;
        if (defers >= CONFIG.MAX_DEFERS) return false; // cap reached → never again

        // Never deferred yet → first ask once they've gotten real value.
        if (defers === 0) return (state.exports || 0) >= CONFIG.INITIAL_EXPORTS;

        // Deferred before → wait the scheduled window AND require a new export.
        const delayDays = CONFIG.REASK_SCHEDULE_DAYS[defers - 1];
        const since = Date.now() - (state.lastDeferAt || 0);
        return since >= delayDays * DAY && (state.exports || 0) > (state.exportsAtDefer || 0);
    }

    // ==================== External links ====================
    function openTab(url) {
        try {
            if (chrome.tabs && chrome.tabs.create) { chrome.tabs.create({ url }); return; }
        } catch (_) { /* fall through */ }
        window.open(url, '_blank', 'noopener');
    }
    function openStore() { openTab(CONFIG.STORE_URL); }
    function openBugChannel() { openTab(CONFIG.BUG_URL); }

    // ==================== Overlay ====================
    function makeT(translations) {
        return (key) => (translations && translations[key]) || EN[key] || key;
    }

    // Escape HTML, then turn **word** into <strong>word</strong> so a few key
    // words in the body can be emphasised. Input is our own locale text.
    function mdBold(s) {
        const esc = String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    }

    function closeOverlay(overlay, prevFocus) {
        if (!overlay || overlay._closing) return;
        overlay._closing = true;
        overlay.classList.remove('xrp-in');
        if (overlay._onKey) document.removeEventListener('keydown', overlay._onKey);
        const remove = () => {
            overlay.remove();
            if (activeOverlay === overlay) activeOverlay = null;
            if (prevFocus && typeof prevFocus.focus === 'function') {
                try { prevFocus.focus(); } catch (_) { /* element gone */ }
            }
        };
        overlay.addEventListener('transitionend', remove, { once: true });
        setTimeout(remove, 420); // fallback if transitionend never fires
    }

    // Record a deferral: bump the counter (toward MAX_DEFERS), stamp the time,
    // and capture the export baseline so the next ask needs a fresh export.
    async function markDeferred() {
        const s = await loadState();
        await patchState({
            status: 'pending',
            deferCount: (s.deferCount || 0) + 1,
            lastDeferAt: Date.now(),
            exportsAtDefer: s.exports || 0
        });
    }

    function renderThanks(card, t) {
        card.classList.add('xrp-thanks');
        card.innerHTML = '<div class="xrp-thanks-wrap"><div class="xrp-thanks-icon">' +
            HEART_SVG + '</div><h3 class="xrp-title xrp-thanks-title"></h3></div>';
        card.querySelector('.xrp-thanks-title').textContent = t('rateThanks');
    }

    function buildOverlay(t, onReportBug) {
        const prevFocus = document.activeElement;

        const overlay = document.createElement('div');
        overlay.className = 'xrp-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'xrp-title');
        overlay.innerHTML =
            '<div class="xrp-card" role="document">' +
            '<button type="button" class="xrp-close"></button>' +
            '<div class="xrp-glow" aria-hidden="true"></div>' +
            '<div class="xrp-stars" aria-hidden="true">' + STAR_SVG.repeat(5) + '</div>' +
            '<h3 class="xrp-title" id="xrp-title"></h3>' +
            '<p class="xrp-body"></p>' +
            '<button type="button" class="xrp-btn xrp-btn-primary xrp-rate">' + STAR_SVG + '<span class="xrp-rate-label"></span></button>' +
            '<button type="button" class="xrp-later"></button>' +
            '<button type="button" class="xrp-report"></button>' +
            '</div>';

        overlay.querySelectorAll('.xrp-stars svg').forEach((s) => s.classList.add('xrp-star'));
        overlay.querySelector('.xrp-rate svg').classList.add('xrp-cta-star');

        const closeBtn = overlay.querySelector('.xrp-close');
        closeBtn.innerHTML = X_SVG;
        closeBtn.setAttribute('aria-label', t('rateClose'));
        overlay.querySelector('.xrp-title').textContent = t('rateTitle');
        overlay.querySelector('.xrp-body').innerHTML = mdBold(t('rateBody'));
        overlay.querySelector('.xrp-rate-label').textContent = t('rateCta');
        overlay.querySelector('.xrp-later').textContent = t('rateLater');
        overlay.querySelector('.xrp-report').textContent = t('rateReport');

        const card = overlay.querySelector('.xrp-card');

        const later = async () => {
            await markDeferred();
            closeOverlay(overlay, prevFocus);
        };

        overlay.querySelector('.xrp-rate').addEventListener('click', async () => {
            // Persist BEFORE opening the tab: in the popup, the new tab closes
            // the popup and could otherwise drop the in-flight storage write.
            await patchState({ status: 'rated' });
            openStore();
            renderThanks(card, t);
            setTimeout(() => closeOverlay(overlay, prevFocus), 1500);
        });
        overlay.querySelector('.xrp-later').addEventListener('click', later);
        closeBtn.addEventListener('click', later);

        // Deflect unhappy users to the bug channel instead of a 1-star review.
        // Treated as a deferral, not a permanent dismissal.
        overlay.querySelector('.xrp-report').addEventListener('click', async () => {
            await markDeferred();
            closeOverlay(overlay, prevFocus);
            if (typeof onReportBug === 'function') onReportBug();
            else openBugChannel();
        });

        // Click on the backdrop (outside the card) = treat as "later".
        overlay.addEventListener('click', (e) => { if (e.target === overlay) later(); });

        // Esc closes; Tab is trapped inside the card.
        overlay._onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); later(); return; }
            if (e.key === 'Tab') {
                const f = overlay.querySelectorAll('button');
                if (!f.length) return;
                const first = f[0], last = f[f.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        };
        document.addEventListener('keydown', overlay._onKey);

        document.body.appendChild(overlay);
        activeOverlay = overlay;
        // Trigger the fade/slide-in. The rAF path runs first when the tab is
        // visible; the timeout is a fallback for throttled rAF (idempotent).
        requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('xrp-in')));
        setTimeout(() => overlay.classList.add('xrp-in'), 40);
        const primary = overlay.querySelector('.xrp-rate');
        if (primary) primary.focus();
    }

    // ==================== Public API ====================
    async function show(opts) {
        const o = opts || {};
        if (activeOverlay) return false;
        const state = await loadState();
        if (!ready(state)) return false;
        await patchState({ lastShownAt: Date.now() });
        buildOverlay(makeT(o.translations), o.onReportBug);
        return true;
    }

    function maybeShow(opts) {
        return show(opts);
    }

    async function incrementExports(exportKey) {
        const s = await loadState();
        const key = String(exportKey || '');
        if (key && s.lastCountedExportKey === key) return;
        await patchState({
            exports: (s.exports || 0) + 1,
            lastCountedExportKey: key || s.lastCountedExportKey || ''
        });
    }

    async function rateNow() {
        await patchState({ status: 'rated' });
        openStore();
    }

    window.XPorterRatePrompt = {
        maybeShow, show, incrementExports, rateNow, openStore, openBugChannel, CONFIG
    };
})();
