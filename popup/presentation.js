// Popup shell interactions: tooltips, tabs, notifications and clipboard.
// Export state and settings have their own owners.
(function (root) {
    'use strict';
    function mount({ popup, t }) {
        const tabs = document.querySelectorAll('.tab');
        const tabContents = document.querySelectorAll('.tab-content');
        // All help lives in the browser top layer, outside preferred-size and scroll
        // calculations. Viewport coordinates are converted for inherited CSS zoom.
        let openHelp = null;
        let helpCloseTimer = null;
        function positionViewportHelp(trigger) {
            const tooltip = trigger.querySelector(':scope > .help-pop');
            if (!tooltip) return;
            const zoom = parseFloat(getComputedStyle(popup).zoom) || 1;
            const measuredZoom = trigger.getBoundingClientRect().width / trigger.offsetWidth || 1;
            // Before Chrome 128 DOMRects omit inherited CSS zoom. Detect the
            // coordinate model from geometry, not a browser-version guess.
            const coordinateScale = Math.abs(measuredZoom - zoom) < 0.02 ? 1 : zoom;
            const viewportRect = element => {
                const rect = element?.getBoundingClientRect();
                return rect && {
                    left: rect.left * coordinateScale, top: rect.top * coordinateScale,
                    bottom: rect.bottom * coordinateScale
                };
            };
            const triggerRect = viewportRect(trigger);
            const tabsRect = viewportRect(document.querySelector('.tabs'));
            const safeTop = tabsRect && tabsRect.bottom > 0 && tabsRect.top < innerHeight
                ? Math.max(8, tabsRect.bottom + 8) : 8;
            const footerRect = viewportRect(document.querySelector('.footer'));
            const safeBottom = footerRect && footerRect.top > 0 && footerRect.top < innerHeight
                ? footerRect.top - 8 : innerHeight - 8;
            const width = Math.max(0, Math.min(360 * zoom, innerWidth - 32));
            const left = Math.max(16, Math.min(triggerRect.left, innerWidth - width - 16));
            tooltip.style.setProperty('--help-pop-width', `${width / zoom}px`);
            tooltip.style.setProperty('--help-pop-max-height', 'none');
            const border = getComputedStyle(tooltip);
            const naturalHeight = (tooltip.scrollHeight + parseFloat(border.borderTopWidth) +
                parseFloat(border.borderBottomWidth)) * zoom;
            const belowTop = Math.max(safeTop, triggerRect.bottom + 8);
            const aboveBottom = Math.min(safeBottom, triggerRect.top - 8);
            const below = Math.max(0, safeBottom - belowTop);
            const above = Math.max(0, aboveBottom - safeTop);
            const placeBelow = naturalHeight <= below || (naturalHeight > above && below >= above);
            const maxHeight = placeBelow ? below : above;
            const top = placeBelow ? belowTop : Math.max(safeTop, aboveBottom - Math.min(naturalHeight, above));
            tooltip.style.setProperty('--help-pop-left', `${left / zoom}px`);
            tooltip.style.setProperty('--help-pop-safe-top', `${top / zoom}px`);
            tooltip.style.setProperty('--help-pop-max-height', `${maxHeight / zoom}px`);
        }
        function closeHelp() {
            clearTimeout(helpCloseTimer);
            const tooltip = openHelp?.querySelector(':scope > .help-pop');
            if (tooltip?.matches(':popover-open')) tooltip.hidePopover();
            openHelp?.classList.remove('help-open');
            openHelp = null;
        }
        function showHelp(trigger) {
            // Localization may still be inserting the popover during initial hover.
            const tooltip = trigger.querySelector(':scope > .help-pop');
            if (!tooltip) return;
            clearTimeout(helpCloseTimer);
            // Chrome 111–113 has no Popover API (including its CSS selector).
            // Native help preserves the explanation without opening an unbounded overlay.
            if (typeof tooltip.showPopover !== 'function' || typeof tooltip.hidePopover !== 'function') {
                trigger.setAttribute('title', trigger.getAttribute('aria-label') || tooltip.textContent);
                return;
            }
            if (openHelp !== trigger) closeHelp();
            openHelp = trigger;
            tooltip.setAttribute('popover', 'manual');
            if (!tooltip.matches(':popover-open')) tooltip.showPopover();
            trigger.classList.remove('help-dismissed');
            trigger.classList.add('help-open');
            positionViewportHelp(trigger);
        }
        document.querySelectorAll('[data-i18n-tooltip]').forEach(trigger => {
            trigger.addEventListener('pointerenter', () => showHelp(trigger));
            trigger.addEventListener('focus', () => showHelp(trigger));
            trigger.addEventListener('pointerleave', () => {
                // Allows crossing the small gap into a long scrollable tooltip.
                helpCloseTimer = setTimeout(() => {
                    if (document.activeElement !== trigger) closeHelp();
                }, 160);
            });
            trigger.addEventListener('focusout', () => { if (!trigger.matches(':hover')) closeHelp(); });
            trigger.addEventListener('click', () => showHelp(trigger));
            trigger.addEventListener('keydown', event => {
                if (event.key === 'Escape') {
                    closeHelp();
                    trigger.classList.add('help-dismissed');
                    event.preventDefault();
                }
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    showHelp(trigger);
                }
            });
        });
        function repositionHelp() {
            if (openHelp) positionViewportHelp(openHelp);
        }
        window.addEventListener('resize', repositionHelp);
        document.addEventListener('scroll', event => {
            if (!openHelp?.contains(event.target)) repositionHelp();
        }, true);
        document.addEventListener('pointerdown', event => {
            if (openHelp && !openHelp.contains(event.target)) closeHelp();
        });

        // ==================== Toast Notifications ====================
        // Replaces native alert() — keeps the glass aesthetic and is non-blocking.
        // One persistent live region (#toastRegion in popup.html), present
        // before the first message: screen readers announce additions to an
        // existing region far more reliably than freshly inserted role nodes.
        function showToast(message, type = 'info') {
            if (!message) return;
            const toastContainer = document.getElementById('toastRegion');
            const toast = document.createElement('div');
            toast.className = `toast toast-${type}`;
            toast.textContent = message;
            toastContainer.appendChild(toast);
            // Force reflow then animate in
            requestAnimationFrame(() => toast.classList.add('toast-show'));
            setTimeout(() => {
                toast.classList.remove('toast-show');
                setTimeout(() => toast.remove(), 250);
            }, type === 'error' ? 4500 : 2800);
        }

        // ==================== Tabs ====================
        function activateTab(tab, focus = false) {
            closeHelp();
            const previous = document.querySelector('.tab.active');
            tabs.forEach(t => {
                const selected = t === tab;
                t.classList.toggle('active', selected);
                t.setAttribute('aria-selected', selected ? 'true' : 'false');
                t.tabIndex = selected ? 0 : -1;
            });
            tabContents.forEach(c => c.classList.remove('active'));
            const panel = document.getElementById('tab-' + tab.dataset.tab);
            panel.classList.add('active');
            root.XPorterMotion?.tabChanged(previous, tab, panel);
            if (focus) tab.focus();
        }

        tabs.forEach((tab, index) => {
            tab.addEventListener('click', () => activateTab(tab));
            tab.addEventListener('keydown', (event) => {
                let nextIndex = null;
                const direction = document.documentElement.dir === 'rtl' ? -1 : 1;
                if (event.key === 'ArrowRight') nextIndex = (index + direction + tabs.length) % tabs.length;
                if (event.key === 'ArrowLeft') nextIndex = (index - direction + tabs.length) % tabs.length;
                if (event.key === 'Home') nextIndex = 0;
                if (event.key === 'End') nextIndex = tabs.length - 1;
                if (nextIndex === null) return;
                event.preventDefault();
                activateTab(tabs[nextIndex], true);
            });
        });
        activateTab(document.querySelector('.tab.active') || tabs[0]);

        async function writeClipboardText(text) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                // Fallback for older browsers / restricted clipboard access.
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                let copied = false;
                try { copied = document.execCommand('copy'); } catch { /* noop */ }
                ta.remove();
                return copied;
            }
        }

        // ==================== Copy-to-clipboard (About tab email) ====================
        document.querySelectorAll('[data-copy]').forEach(el => {
            el.addEventListener('click', async (e) => {
                e.preventDefault();
                const text = el.getAttribute('data-copy');
                if (!text) return;
                if (!await writeClipboardText(text)) {
                    showToast(t('errCopyFailed'), 'error');
                    return;
                }
                const target = el.closest('.email-action') || el;
                target.classList.add('is-copied');
                showToast(t('contactCopied') || 'Copied!', 'success');
                clearTimeout(el._copyTimer);
                el._copyTimer = setTimeout(() => target.classList.remove('is-copied'), 1800);
            });
        });

        // ==================== About-tab accordions ====================
        document.querySelectorAll('.detail-head').forEach(head => {
            head.addEventListener('click', () => {
                const item = head.closest('.detail-item');
                const isOpen = item.classList.toggle('open');
                head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                root.XPorterMotion?.disclosureChanged(item, isOpen);
            });
        });

        return Object.freeze({ showToast, writeClipboardText });
    }
    root.XPorterPopupUI = Object.freeze({ mount });
})(globalThis);

// Home owns the shell height; longer tabs scroll within that same shell.
function mountHomeSizing() {
    const popup = document.getElementById('popup');
    const home = document.getElementById('tab-home');
    let pending = false;
    function schedule() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            const scroller = document.getElementById('homeContent');
            const scrollTop = scroller.scrollTop;
            popup.classList.add('measuring-home');
            // Size the window for where running disclosures end, not mid-way.
            const measure = () => home.offsetHeight;
            const homeHeight = globalThis.XPorterMotion
                ? XPorterMotion.withFinalLayout(home, measure) : measure();
            const headerHeight = popup.querySelector('.header').offsetHeight;
            const height = homeHeight + headerHeight
                + popup.querySelector('.tabs').offsetHeight;
            popup.classList.remove('measuring-home');
            popup.style.setProperty('--home-height', `${height}px`);
            popup.style.setProperty('--header-height', `${headerHeight}px`);
            scroller.scrollTop = scrollTop;
        });
    }
    // Only structural changes can move Home's height: nodes (textContent
    // replacement included) and visibility classes. Rolling-counter digit
    // data, progress widths and tooltip positions must not force a measurement.
    new MutationObserver(schedule).observe(home, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'hidden']
    });
    new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    new ResizeObserver(schedule).observe(popup.querySelector('.header'));
    document.fonts.ready.then(schedule);
    schedule();
}
