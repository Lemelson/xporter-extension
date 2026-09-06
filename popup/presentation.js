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
            const triggerRect = trigger.getBoundingClientRect();
            const zoom = triggerRect.width / trigger.offsetWidth || 1;
            const tabsRect = document.querySelector('.tabs')?.getBoundingClientRect();
            const safeTop = tabsRect && tabsRect.bottom > 0 && tabsRect.top < innerHeight
                ? Math.max(8, tabsRect.bottom + 8) : 8;
            const footerRect = document.querySelector('.footer')?.getBoundingClientRect();
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
        let toastContainer = null;
        function showToast(message, type = 'info') {
            if (!message) return;
            if (!toastContainer) {
                toastContainer = document.createElement('div');
                toastContainer.className = 'toast-container';
                popup.appendChild(toastContainer);
            }
            const toast = document.createElement('div');
            toast.className = `toast toast-${type}`;
            toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
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
            tabs.forEach(t => {
                const selected = t === tab;
                t.classList.toggle('active', selected);
                t.setAttribute('aria-selected', selected ? 'true' : 'false');
                t.tabIndex = selected ? 0 : -1;
            });
            tabContents.forEach(c => c.classList.remove('active'));
            document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
            if (focus) tab.focus();
        }

        tabs.forEach((tab, index) => {
            tab.addEventListener('click', () => activateTab(tab));
            tab.addEventListener('keydown', (event) => {
                let nextIndex = null;
                if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
                if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
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
            });
        });

        return Object.freeze({ showToast, writeClipboardText });
    }
    root.XPorterPopupUI = Object.freeze({ mount });
})(globalThis);
