// Observe only download IDs created by XPorter. Browser IDs stay local.
(function () {
    const diagnostics = () => globalThis.XPorterDiagnostics;
    async function observe(item) {
        if (!item || !['complete', 'interrupted'].includes(item.state)) return;
        const state = await diagnostics()?.load();
        if (!state?.pendingDownloads[String(item.id)]) return;
        await diagnostics().record('download_state', { downloadId: item.id, state: item.state, error: item.error });
    }
    async function reconcile(id) {
        try {
            const items = await chrome.downloads.search({ id });
            if (items[0]) await observe(items[0]);
            else await diagnostics()?.record('download_missing', { downloadId: id });
        } catch (_) { /* retry on next worker start; no invented success */ }
    }
    async function track(id, transaction, bytes) {
        if (!transaction || !Number.isInteger(id) || !diagnostics()) return;
        await diagnostics().record('download_file', { id: transaction, downloadId: id, bytes });
        // Covers small files that finished before their ID was bound locally.
        await reconcile(id);
    }
    chrome.downloads?.onChanged?.addListener(change => {
        if (!change.state || !diagnostics()) return;
        observe({ id: change.id, state: change.state.current, error: change.error?.current }).catch(() => {});
    });
    async function recover() {
        const state = await diagnostics()?.load();
        for (const id of Object.keys(state?.pendingDownloads || {})) await reconcile(Number(id));
    }
    globalThis.XPorterDownloadDiagnostics = { track, recover };
})();
