// XPorter — passive seen-posts UI module
// Owns summary rendering, dataset downloads, clearing, and its disclosure row.

(function () {
    function mount({ t, showToast, getLanguage }) {
        const countElement = document.getElementById('feedDbCount');
        const summaryElement = document.getElementById('feedDbSummary');
        const csvButton = document.getElementById('downloadFeedCsv');
        const jsonButton = document.getElementById('downloadFeedJson');
        const clearButton = document.getElementById('clearFeedDb');
        const toggle = document.getElementById('feedDbToggle');
        const chevron = document.getElementById('feedDbChevron');
        const body = document.getElementById('feedDbBody');
        let summary = null;

        if (!countElement || !summaryElement || !csvButton || !jsonButton || !clearButton) {
            return { refresh: async () => {}, refreshLanguage() {} };
        }

        function render() {
            const count = Number(summary?.count) || 0;
            const language = getLanguage();
            countElement.textContent = count.toLocaleString(language);
            if (count === 0) {
                summaryElement.textContent = t('feedStatsEmpty');
            } else {
                const lastSeen = summary?.lastSeenAt
                    ? new Date(summary.lastSeenAt).toLocaleString(language)
                    : '—';
                summaryElement.textContent = `${t('feedStatsCount')}: ${count.toLocaleString(language)} · ${t('feedStatsLastSeen')}: ${lastSeen}`;
            }
            csvButton.disabled = count === 0;
            jsonButton.disabled = count === 0;
            clearButton.disabled = count === 0;
        }

        async function refresh() {
            const result = await sendMessage({ type: 'GET_FEED_DB_SUMMARY' });
            if (result?.error) return;
            summary = result;
            render();
        }

        async function download(format, button) {
            button.disabled = true;
            const result = await sendMessage(
                { type: 'DOWNLOAD_FEED_DB', outputFormat: format },
                XPORTER_CONFIG.DOWNLOAD_MESSAGE_TIMEOUT || 30000
            );
            button.disabled = false;
            showToast(
                result?.success ? t('downloadStarted') : formatError(result?.error || 'DOWNLOAD_FAILED', t),
                result?.success ? 'success' : 'error'
            );
        }

        csvButton.addEventListener('click', () => download('csv', csvButton));
        jsonButton.addEventListener('click', () => download('json', jsonButton));
        clearButton.addEventListener('click', async () => {
            if (!window.confirm(t('clearSeenConfirm'))) return;
            const result = await sendMessage({ type: 'CLEAR_FEED_DB' });
            if (result?.success) {
                showToast(t('seenDataCleared'), 'success');
                await refresh();
            } else {
                showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
            }
        });
        toggle?.addEventListener('click', () => {
            const isOpen = !body.classList.contains('hidden');
            body.classList.toggle('hidden');
            chevron.classList.toggle('open');
            toggle.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
        });

        refresh();
        return { refresh, refreshLanguage: render };
    }

    globalThis.XPorterSeenPosts = { mount };
})();
