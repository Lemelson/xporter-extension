// Editable target profile and viewer-owned Bookmarks account cards.
(function (root) {
    'use strict';
    function mount({ detectedCurrentAccount, detectedTargetAccount, getTranslations }) {
        const usernameInput = document.getElementById('usernameInput');
        const usernameLabel = document.getElementById('usernameLabel');
        const usernamePrefix = document.getElementById('usernamePrefix');
        const usernameField = document.getElementById('usernameField');
        const usernameError = document.getElementById('usernameError');
        const targetAccountCard = document.getElementById('targetAccountCard');
        const targetAccountName = document.getElementById('targetAccountName');
        const targetAccountHandleEditor =
            document.getElementById('targetAccountHandleEditor');
        const targetAccountAvatar = document.getElementById('targetAccountAvatar');
        const targetAccountAvatarFallback =
            document.getElementById('targetAccountAvatarFallback');
        const bookmarksAccountField = document.getElementById('bookmarksAccountField');
        const bookmarksAccountName = document.getElementById('bookmarksAccountName');
        const bookmarksAccountHandle = document.getElementById('bookmarksAccountHandle');
        const bookmarksAccountAvatar = document.getElementById('bookmarksAccountAvatar');
        const bookmarksAccountAvatarFallback =
            document.getElementById('bookmarksAccountAvatarFallback');
        let bookmarksUsernameBackup = '';
        let exportAccount = null;

        function renderAccountAvatar(image, fallback, avatarUrl) {
            const showFallback = () => {
                image.removeAttribute('src');
                image.classList.add('hidden');
                fallback.classList.remove('hidden');
            };
            image.onerror = showFallback;
            if (avatarUrl) {
                image.src = avatarUrl;
                image.classList.remove('hidden');
                fallback.classList.add('hidden');
            } else {
                showFallback();
            }
        }

        function renderTargetAccount() {
            const username = extractUsernameFromInput(usernameInput.value);
            const matches = account => username &&
                String(account?.username || '').toLowerCase() === username.toLowerCase();
            const live = matches(detectedTargetAccount) ? detectedTargetAccount : null;
            const saved = matches(exportAccount) ? exportAccount : null;
            const account = { name: live?.name || saved?.name || '',
                avatarUrl: live?.avatarUrl || saved?.avatarUrl || '' };
            const name = String(account?.name || '').trim();
            targetAccountName.textContent = name;
            targetAccountName.classList.toggle('hidden', !name);
            renderAccountAvatar(
                targetAccountAvatar,
                targetAccountAvatarFallback,
                String(account?.avatarUrl || '')
            );
        }

        function renderBookmarksAccount() {
            const account = detectedCurrentAccount || {};
            const username = String(account.username || '').replace(/^@/, '');
            bookmarksAccountName.textContent = account.name ||
                getTranslations().signedInXAccount || 'Signed-in X account';
            bookmarksAccountHandle.textContent = username ? `@${username}` : '';
            bookmarksAccountHandle.classList.toggle('hidden', !username);
            renderAccountAvatar(
                bookmarksAccountAvatar,
                bookmarksAccountAvatarFallback,
                String(account.avatarUrl || '')
            );
        }

        // The full inset reads as an editable field; clicking its prefix or pencil
        // should place the caret in the real native input without blocking paste or
        // text selection inside the input itself.
        targetAccountHandleEditor.addEventListener('click', (event) => {
            if (event.target !== usernameInput) usernameInput.focus();
        });

        // Auto-clean input on paste or type
        usernameInput.addEventListener('input', () => {
            const raw = usernameInput.value;
            if (raw.includes('x.com/') || raw.includes('twitter.com/') || raw.startsWith('@')) {
                const cleaned = extractUsernameFromInput(raw);
                if (cleaned && cleaned !== raw) {
                    usernameInput.value = cleaned;
                }
            }
            targetAccountCard.classList.remove('is-invalid');
            usernameInput.removeAttribute('aria-invalid');
            usernameError.classList.add('hidden');
            renderTargetAccount();
        });

        return Object.freeze({
            updateExportAccount(state) {
                if (state.userInfo && state.exportMode !== 'bookmarks') {
                    const info = state.userInfo;
                    exportAccount = { username: info.screenName || state.username,
                        name: info.name || '', avatarUrl: info.profileImageUrl || '' };
                }
            },
            applyMode(mode) {
                const isBookmarksMode = mode === 'bookmarks';
                if (isBookmarksMode) {
                    if (!usernameInput.disabled) bookmarksUsernameBackup = usernameInput.value;
                    usernameInput.disabled = true;
                    usernameInput.value = '';
                    usernameField.classList.add('hidden');
                    bookmarksAccountField.classList.remove('hidden');
                    renderBookmarksAccount();
                } else {
                    if (usernameInput.disabled) usernameInput.value = bookmarksUsernameBackup;
                    usernameInput.disabled = false;
                    usernameField.classList.remove('hidden');
                    bookmarksAccountField.classList.add('hidden');
                    usernameLabel.textContent =
                        getTranslations().fieldUsername || 'Twitter Username';
                    usernamePrefix.classList.remove('hidden');
                    renderTargetAccount();
                }
            }
        });
    }
    root.XPorterAccountFields = Object.freeze({ mount });
})(globalThis);
