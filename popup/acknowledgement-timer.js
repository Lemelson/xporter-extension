// XPorter — guarded acknowledgement button countdown
(function (global) {
    'use strict';

    function start(button, options = {}) {
        const seconds = Math.max(0, Math.floor(Number(options.seconds) || 0));
        const readyLabel = String(options.readyLabel || '');
        const waitingLabel = typeof options.waitingLabel === 'function'
            ? options.waitingLabel
            : (label, remaining) => `${label} (${remaining})`;
        const onChange = typeof options.onChange === 'function'
            ? options.onChange
            : () => {};
        const schedule = options.schedule || ((callback) => setTimeout(callback, 1000));
        const cancelSchedule = options.cancelSchedule || clearTimeout;
        let timerId = null;
        let remaining = seconds;
        let cancelled = false;

        function showReady() {
            button.disabled = false;
            button.textContent = readyLabel;
            button.removeAttribute('aria-disabled');
            onChange({ ready: true, remaining: 0, text: button.textContent });
        }

        function showWaiting() {
            button.disabled = true;
            button.textContent = waitingLabel(readyLabel, remaining);
            button.setAttribute('aria-disabled', 'true');
            onChange({ ready: false, remaining, text: button.textContent });
        }

        function tick() {
            if (cancelled) return;
            remaining -= 1;
            if (remaining <= 0) {
                timerId = null;
                showReady();
                return;
            }
            showWaiting();
            timerId = schedule(tick);
        }

        if (remaining <= 0) {
            showReady();
        } else {
            showWaiting();
            timerId = schedule(tick);
        }

        return {
            cancel() {
                cancelled = true;
                if (timerId !== null) cancelSchedule(timerId);
            }
        };
    }

    global.XPorterAcknowledgementTimer = Object.freeze({ start });
})(typeof globalThis !== 'undefined' ? globalThis : window);
