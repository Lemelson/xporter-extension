// XPorter — anonymous usage tracker (loaded by popup + export pages)
// =====================================================================
// Counts how many times the UI is opened and how long it is actively VISIBLE,
// so the uninstall churn stats can tell "installed but never really used" from
// "used a lot, then left". Fully anonymous — no X data, nothing identifying.
//
// Everything is wrapped so a failure here can NEVER break the UI. Active time
// is measured as real Date.now() deltas from the moment the page becomes
// visible AND focused (visibility alone double-counted when the popup and the
// export tab were both on screen), accumulated in memory and flushed to the
// service worker every few seconds (and on hide/unload). A popup that closes
// abruptly loses at most one flush interval rather than the whole session,
// and even a 3-second visit records its ~3s instead of rounding down to 0.
(function () {
    'use strict';
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

    var TICK_MS = 5000;       // heartbeat that folds elapsed time into pendingMs
    var FLUSH_MS = 10000;     // push pending ms to the worker at most this often
    var pendingMs = 0;        // active ms accumulated since the last flush
    var sinceFlush = 0;
    var activeSince = null;   // Date.now() when the page became visible+focused
    var timer = null;
    var openSent = false;     // XP_SESSION_OPEN goes out on first real visibility

    function send(msg) {
        try {
            chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; });
        } catch (_) { /* ignore */ }
    }

    // Only the visible AND focused page counts — two visible XPorter pages
    // must not both accumulate the same wall-clock second.
    function isActive() {
        try {
            return document.visibilityState === 'visible' && document.hasFocus();
        } catch (_) {
            return document.visibilityState === 'visible';
        }
    }

    // Fold the elapsed part of the current active interval into pendingMs
    // (real ms, not whole ticks) and restart the interval from "now".
    function collect() {
        if (activeSince === null) return;
        var now = Date.now();
        pendingMs += Math.max(0, now - activeSince);
        activeSince = now;
    }

    function flush(force) {
        collect();
        if (pendingMs <= 0) return; // second flush of a double-flush is a no-op
        send({ type: 'XP_ACTIVE_TICK', ms: pendingMs, flush: !!force });
        pendingMs = 0;
        sinceFlush = 0;
    }

    function tick() {
        if (!isActive()) return;
        collect();
        sinceFlush += TICK_MS;
        if (sinceFlush >= FLUSH_MS) flush(false);
    }

    function start() { if (!timer) timer = setInterval(tick, TICK_MS); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    function update() {
        // Count the open on first real visibility — NOT at script load, so
        // session-restored background tabs don't inflate the opens counter.
        if (!openSent && document.visibilityState === 'visible') {
            openSent = true;
            send({ type: 'XP_SESSION_OPEN' });
        }
        if (isActive()) {
            if (activeSince === null) activeSince = Date.now();
            start();
        } else {
            collect();          // bank the partial interval up to this moment
            activeSince = null; // and stop accumulating while inactive
            if (document.visibilityState !== 'visible') {
                stop();
                flush(true); // page hidden — push what we have (best effort)
            }
        }
    }

    // Final flush on teardown. Nulling activeSince keeps the pagehide +
    // beforeunload double-flush idempotent: the second call collects nothing
    // and flush() bails on pendingMs === 0.
    function shutdown() {
        stop();
        collect();
        activeSince = null;
        flush(true);
    }

    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    window.addEventListener('pagehide', shutdown);
    window.addEventListener('beforeunload', shutdown);

    // Initial state: may already be visible (normal popup open) or hidden
    // (restored tab) — update() handles both.
    update();
})();
