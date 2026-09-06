// Popup shell interactions: tooltips, tabs, notifications and clipboard.
// Export state and settings have their own owners.
(function (root) {
    'use strict';
    function mount({ popup, t }) {
        const tabs = document.querySelectorAll('.tab');
        const tabContents = document.querySelectorAll('.tab-content');
        // Long localized help must use the visible popup area below the tabs.
        // Recalculate on every open because Chromium can scroll the popup between
        // interactions, which changes whether the header, tabs, and footer are visible.
        function positionViewportHelp(trigger) {
            const tooltip = trigger.querySelector(':scope > .help-pop');
            if (!tooltip) return;
            const tabsRect = document.querySelector('.tabs')?.getBoundingClientRect();
            const tabsAreVisible = tabsRect &&
                tabsRect.bottom > 0 &&
                tabsRect.top < window.innerHeight;
            const safeTop = tabsAreVisible ? Math.max(8, tabsRect.bottom + 8) : 8;
            const footerRect = document.querySelector('.footer')?.getBoundingClientRect();
            const safeBottom = footerRect && footerRect.top > 0 && footerRect.top < window.innerHeight
                ? footerRect.top - 8
                : window.innerHeight - 8;
            const triggerRect = trigger.getBoundingClientRect();
            // The active tab briefly animates with transform, so a fixed child can
            // unexpectedly become relative to that tab. Position explicitly from
            // the tooltip's actual offset parent to keep viewport geometry stable.
            const parentRect = tooltip.offsetParent?.getBoundingClientRect() ||
                trigger.parentElement.getBoundingClientRect();
            trigger.style.setProperty('--help-pop-left', `${16 - parentRect.left}px`);
            trigger.style.setProperty('--help-pop-width', `${window.innerWidth - 32}px`);
            const safeAreaTop = safeTop + 4;
            let tooltipTop = safeAreaTop;
            let maxHeight = Math.max(0, safeBottom - safeAreaTop);

            if (trigger.classList.contains('help-below')) {
                const belowTop = Math.max(safeAreaTop, triggerRect.bottom + 8);
                const availableBelow = Math.max(0, safeBottom - belowTop);
                const aboveBottom = triggerRect.top - 8;
                const availableAbove = Math.max(0, aboveBottom - safeAreaTop);
                const borderHeight = parseFloat(getComputedStyle(tooltip).borderTopWidth) +
                    parseFloat(getComputedStyle(tooltip).borderBottomWidth);
                const naturalHeight = tooltip.scrollHeight + borderHeight;

                if (naturalHeight <= availableBelow ||
                    (naturalHeight > availableAbove && availableBelow >= availableAbove)) {
                    tooltipTop = belowTop;
                    maxHeight = availableBelow;
                } else {
                    maxHeight = availableAbove;
                    tooltipTop = Math.max(
                        safeAreaTop,
                        aboveBottom - Math.min(naturalHeight, availableAbove)
                    );
                }
            }

            trigger.style.setProperty('--help-pop-safe-top', `${tooltipTop - parentRect.top}px`);
            trigger.style.setProperty('--help-pop-max-height', `${maxHeight}px`);
        }

        document.querySelectorAll('.help-viewport').forEach((trigger) => {
            trigger.addEventListener('pointerenter', () => positionViewportHelp(trigger));
            trigger.addEventListener('pointermove', () => positionViewportHelp(trigger));
            trigger.addEventListener('focus', () => positionViewportHelp(trigger));
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
