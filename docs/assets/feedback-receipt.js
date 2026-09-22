// Apps Script POST responses are opaque cross-origin. Confirm explicit Send
// with a tiny read-only JSONP receipt; never display success from fetch alone.
(function () {
    function check(endpoint, sessionId, receiptId, test = false) {
        return new Promise(resolve => {
            const callback = 'xpReceipt_' + crypto.randomUUID().replace(/-/g, '');
            const script = document.createElement('script');
            let settled = false;
            const finish = ok => {
                if (settled) return;
                settled = true; clearTimeout(timer); script.remove(); delete globalThis[callback]; resolve(ok);
            };
            const timer = setTimeout(() => finish(false), 8000);
            globalThis[callback] = result => finish(result?.ok === true);
            script.onerror = () => finish(false);
            const query = new URLSearchParams({callback,sessionId,receipt_id:receiptId});
            if (test) query.set('test','1');
            script.src = endpoint + '?' + query;
            document.head.appendChild(script);
        });
    }
    globalThis.XPorterFeedbackReceipt = { check };
})();
