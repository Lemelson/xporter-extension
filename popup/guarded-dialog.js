// Shared modal lifecycle for consequential settings. Confirmation runs in the
// original click stack so Chrome's permission request keeps user activation.
(function (root) {
    'use strict';

    function mount({ popup, dialog, cancelButton, confirmButton, countdownStatus }) {
        let active = null;
        let countdown = null;
        let generation = 0;
        dialog.setAttribute('tabindex', '-1');

        function close(confirmed, replacing = false) {
            if (!active || (!replacing && confirmButton.disabled)) return;
            const action = active;
            const closingGeneration = ++generation;
            active = null;
            countdown.cancel();
            countdown = null;
            dialog.classList.add('hidden');
            popup.inert = false;
            if (confirmed) action.onConfirm();
            else action.onCancel?.();
            requestAnimationFrame(() => {
                if (generation === closingGeneration) action.trigger?.focus();
            });
        }

        cancelButton.addEventListener('click', () => close(false));
        confirmButton.addEventListener('click', () => close(true));
        // Document-level: a backdrop click moves focus to <body>, and Escape or
        // Tab must still reach the open dialog from there.
        document.addEventListener('keydown', (event) => {
            if (!active) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                close(false);
            } else if (event.key === 'Tab') {
                if (confirmButton.disabled) {
                    event.preventDefault();
                    dialog.focus();
                    return;
                }
                const last = confirmButton;
                if (!dialog.contains(document.activeElement)) {
                    event.preventDefault();
                    cancelButton.focus();
                } else if (event.shiftKey && document.activeElement === cancelButton) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    cancelButton.focus();
                }
            }
        });

        return Object.freeze({
            open({ trigger, onConfirm, onCancel, seconds = 5, waitingLabel }) {
                if (active) close(false, true);
                const openingGeneration = ++generation;
                active = { trigger, onConfirm, onCancel };
                countdown = XPorterAcknowledgementTimer.start(confirmButton, {
                    seconds,
                    readyLabel: confirmButton.textContent,
                    waitingLabel,
                    onChange({ ready, text }) {
                        countdownStatus.textContent = text;
                        cancelButton.disabled = !ready;
                    }
                });
                popup.inert = true;
                dialog.classList.remove('hidden');
                requestAnimationFrame(() => {
                    if (generation === openingGeneration) {
                        (confirmButton.disabled ? dialog : cancelButton).focus();
                    }
                });
            }
        });
    }

    root.XPorterGuardedDialog = Object.freeze({ mount });
})(globalThis);
