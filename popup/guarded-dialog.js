// Shared modal lifecycle for consequential settings. Confirmation runs in the
// original click stack so Chrome's permission request keeps user activation.
(function (root) {
    'use strict';

    function mount({ popup, dialog, cancelButton, confirmButton, countdownStatus }) {
        let active = null;
        let countdown = null;
        let generation = 0;

        function close(confirmed) {
            if (!active || (confirmed && confirmButton.disabled)) return;
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
        dialog.addEventListener('keydown', (event) => {
            if (!active) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                close(false);
            } else if (event.key === 'Tab') {
                // The confirm button is not a focus target during its countdown.
                const last = confirmButton.disabled ? cancelButton : confirmButton;
                if (event.shiftKey && document.activeElement === cancelButton) {
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
                if (active) close(false);
                const openingGeneration = ++generation;
                active = { trigger, onConfirm, onCancel };
                countdown = XPorterAcknowledgementTimer.start(confirmButton, {
                    seconds,
                    readyLabel: confirmButton.textContent,
                    waitingLabel,
                    onChange({ text }) { countdownStatus.textContent = text; }
                });
                popup.inert = true;
                dialog.classList.remove('hidden');
                requestAnimationFrame(() => {
                    if (generation === openingGeneration) cancelButton.focus();
                });
            }
        });
    }

    root.XPorterGuardedDialog = Object.freeze({ mount });
})(globalThis);
