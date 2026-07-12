// XPorter — export history module
// Owns history loading, rendering, downloads, and deletion UI.

(function () {
    function mount({ t, showToast, modeLabel, getLanguage }) {
        const toggle = document.getElementById('historyToggle');
        const chevron = document.getElementById('historyChevron');
        const list = document.getElementById('historyList');
        const empty = document.getElementById('historyEmpty');
        if (!toggle || !chevron || !list || !empty) return;

        toggle.addEventListener('click', async () => {
            const isOpen = !list.classList.contains('hidden');
            list.classList.toggle('hidden');
            chevron.classList.toggle('open');
            toggle.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
            if (!isOpen) await loadAndRender();
        });

        async function loadAndRender() {
            const result = await sendMessage({ type: 'GET_EXPORT_HISTORY' });
            if (result?.error) {
                showToast(formatError(result.error, t), 'error');
                return;
            }
            render(result?.history || []);
        }

        function render(history) {
            list.querySelectorAll('.history-card, .history-clear-btn').forEach(element => element.remove());
            if (history.length === 0) {
                empty.classList.remove('hidden');
                return;
            }
            empty.classList.add('hidden');

            for (const entry of history) {
                const card = document.createElement('div');
                card.className = 'history-card';
                card.dataset.id = entry.id;
                card.appendChild(createAvatar(entry));

                const info = document.createElement('div');
                info.className = 'history-info';
                const name = document.createElement('div');
                name.className = 'history-name';
                name.textContent = entry.displayName || entry.username;
                info.appendChild(name);
                const handle = document.createElement('div');
                handle.className = 'history-handle';
                handle.textContent = '@' + (entry.username || '');
                info.appendChild(handle);
                info.appendChild(createMeta(entry));
                card.appendChild(info);

                const actions = document.createElement('div');
                actions.className = 'history-actions';
                if (entry.hasData) actions.appendChild(createDownloadButton(entry));
                actions.appendChild(createDeleteButton(entry, card));
                card.appendChild(actions);
                list.appendChild(card);
            }

            if (history.length > 1) list.appendChild(createClearButton());
        }

        function createAvatar(entry) {
            const fallback = () => {
                const placeholder = document.createElement('div');
                placeholder.className = 'history-avatar-placeholder';
                placeholder.textContent = (entry.displayName || entry.username || '?')[0].toUpperCase();
                return placeholder;
            };
            if (!entry.profileImageUrl || !String(entry.profileImageUrl).startsWith('https://')) {
                return fallback();
            }
            const avatar = document.createElement('img');
            avatar.className = 'history-avatar';
            avatar.src = entry.profileImageUrl;
            avatar.alt = entry.displayName || entry.username || '';
            avatar.onerror = () => avatar.replaceWith(fallback());
            return avatar;
        }

        function createMeta(entry) {
            const meta = document.createElement('div');
            meta.className = 'history-meta';
            const badge = document.createElement('span');
            badge.className = 'history-badge';
            badge.textContent = modeLabel(entry.exportMode || 'posts');
            meta.appendChild(badge);
            meta.appendChild(document.createTextNode(
                ` · ${formatNumber(entry.itemCount || 0, getLanguage())} · ${(entry.outputFormat || 'csv').toUpperCase()}`
            ));
            if (entry.completedAt) {
                const date = new Date(entry.completedAt);
                let dateText;
                try {
                    dateText = date.toLocaleDateString(getLanguage(), { month: 'short', day: 'numeric', year: 'numeric' });
                } catch (_) {
                    dateText = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
                }
                meta.appendChild(document.createTextNode(` · ${dateText}`));
            }
            return meta;
        }

        function createDownloadButton(entry) {
            const button = document.createElement('button');
            button.className = 'history-dl-btn';
            button.title = t('download');
            button.setAttribute('aria-label', t('download'));
            button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
            button.addEventListener('click', async (event) => {
                event.stopPropagation();
                button.disabled = true;
                const result = await sendMessage({
                    type: 'DOWNLOAD_HISTORY_ENTRY',
                    id: entry.id,
                    outputFormat: entry.outputFormat || 'csv'
                }, XPORTER_CONFIG.DOWNLOAD_MESSAGE_TIMEOUT || 30000);
                button.disabled = false;
                showToast(
                    result?.success === true ? t('downloadStarted') : formatError(result?.error || 'DOWNLOAD_FAILED', t),
                    result?.success === true ? 'success' : 'error'
                );
            });
            return button;
        }

        function createDeleteButton(entry, card) {
            const button = document.createElement('button');
            button.className = 'history-del-btn';
            button.title = t('remove');
            button.setAttribute('aria-label', t('remove'));
            button.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            button.addEventListener('click', async (event) => {
                event.stopPropagation();
                button.disabled = true;
                const result = await sendMessage({ type: 'DELETE_HISTORY_ENTRY', id: entry.id });
                button.disabled = false;
                if (result?.success !== true) {
                    showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
                    return;
                }
                card.style.opacity = '0';
                card.style.transform = 'translateX(20px)';
                card.style.transition = 'opacity 0.25s, transform 0.25s';
                setTimeout(() => {
                    card.remove();
                    if (!list.querySelector('.history-card')) {
                        empty.classList.remove('hidden');
                        list.querySelector('.history-clear-btn')?.remove();
                    }
                }, 250);
            });
            return button;
        }

        function createClearButton() {
            const button = document.createElement('button');
            button.className = 'history-clear-btn';
            button.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> ';
            button.appendChild(document.createTextNode(t('clearAll')));
            button.addEventListener('click', async () => {
                button.disabled = true;
                const result = await sendMessage({ type: 'CLEAR_HISTORY' });
                button.disabled = false;
                if (result?.success === true) render([]);
                else showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
            });
            return button;
        }
    }

    globalThis.XPorterHistory = { mount };
})();
