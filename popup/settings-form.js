// XPorter — settings form. Permission-backed choices and navigation settings
// belong to their own controllers, never to this form's debounced snapshot.
(function (root) {
    'use strict';

    function mount({ currentSettings, t, showToast, openAboutRiskDialog }) {
        const includeOriginalPosts = document.getElementById('includeOriginalPosts');
        const includeQuotes = document.getElementById('includeQuotes');
        const includeReplies = document.getElementById('includeReplies');
        const includeRetweets = document.getElementById('includeRetweets');
        const includeArticles = document.getElementById('includeArticles');
        const postSelectionPanel = document.getElementById('postSelectionPanel');
        const postSelectionCount = document.getElementById('postSelectionCount');
        const postSelectionNote = document.getElementById('postSelectionNote');
        const postSelectionError = document.getElementById('postSelectionError');
        const includeBookmarkReplyContext =
            document.getElementById('includeBookmarkReplyContext');
        const includeBookmarkArticles = document.getElementById('includeBookmarkArticles');
        const quantityLimit = document.getElementById('quantityLimit');
        const exportSpeed = document.getElementById('exportSpeed');
        const customSpeedRows = document.getElementById('customSpeedRows');
        const customDelaySec = document.getElementById('customDelaySec');
        const postSafetyBreakEnabled = document.getElementById('postSafetyBreakEnabled');
        const postSafetyBreakRows = document.getElementById('postSafetyBreakRows');
        const postSafetyBreakMin = document.getElementById('postSafetyBreakMin');
        const postSafetyBreakEvery = document.getElementById('postSafetyBreakEvery');
        const userExportSpeed = document.getElementById('userExportSpeed');
        const userCustomSpeedRows = document.getElementById('userCustomSpeedRows');
        const userCustomDelaySec = document.getElementById('userCustomDelaySec');
        const userSafetyBreakEnabled = document.getElementById('userSafetyBreakEnabled');
        const userSafetyBreakRows = document.getElementById('userSafetyBreakRows');
        const userSafetyBreakMin = document.getElementById('userSafetyBreakMin');
        const userSafetyBreakEvery = document.getElementById('userSafetyBreakEvery');
        const includeAboutAccountDetails = document.getElementById('includeAboutAccountDetails');
        const aboutAccountOptions = document.getElementById('aboutAccountOptions');
        const aboutAccountSpeed = document.getElementById('aboutAccountSpeed');
        const aboutAccountCustomRows = document.getElementById('aboutAccountCustomRows');
        const aboutAccountCustomBatchSize = document.getElementById('aboutAccountCustomBatchSize');
        const aboutAccountMaxRetries = document.getElementById('aboutAccountMaxRetries');
        const customQuantityRow = document.getElementById('customQuantityRow');
        const customQuantity = document.getElementById('customQuantity');
        const autoExpireEnabled = document.getElementById('autoExpireEnabled');
        const autoExpireHours = document.getElementById('autoExpireHours');
        const autoExpireRow = document.getElementById('autoExpireRow');
        const ladybugEnabled = document.getElementById('ladybugEnabled');
        const localizeExportHeaders = document.getElementById('localizeExportHeaders');
        const ABOUT_RETRY_WARNING_THRESHOLD = 60;

        const postTypeControls = [
            includeOriginalPosts,
            includeQuotes,
            includeReplies,
            includeRetweets,
            includeArticles
        ];

        function syncPostSelectionUI() {
            const selectedCount = postTypeControls.filter(control => control.checked).length;
            postSelectionCount.textContent = `${selectedCount}/${postTypeControls.length}`;
            postSelectionPanel.classList.toggle('is-empty', selectedCount === 0);
            postSelectionError.classList.toggle('hidden', selectedCount !== 0);
            const hasOtherTypes = postTypeControls.some(
                control => control !== includeReplies && control.checked
            );
            postSelectionNote.classList.toggle(
                'hidden',
                !includeReplies.checked || !hasOtherTypes
            );
            return selectedCount;
        }

        // ==================== Load Settings ====================
        let lastAcceptedAboutRetries = 5;
        if (currentSettings) {
            includeOriginalPosts.checked = currentSettings.includeOriginalPosts !== false;
            includeQuotes.checked = currentSettings.includeQuotes !== false;
            includeReplies.checked = currentSettings.includeReplies === true;
            includeRetweets.checked = currentSettings.includeRetweets === true;
            includeArticles.checked = currentSettings.includeArticles === true;
            syncPostSelectionUI();
            includeBookmarkReplyContext.checked =
                currentSettings.includeBookmarkReplyContext !== false;
            includeBookmarkArticles.checked =
                currentSettings.includeBookmarkArticles !== false;
            const savedLimit = currentSettings.quantityLimit ?? 500;
            const presetValues = Array.from(quantityLimit.options, option => option.value);
            if (presetValues.includes(String(savedLimit))) {
                quantityLimit.value = String(savedLimit);
            } else {
                quantityLimit.value = 'custom';
                customQuantityRow.classList.remove('hidden');
                customQuantity.value = String(savedLimit);
            }
            exportSpeed.value = ['turbo', 'fast', 'standard', 'careful', 'turtle', 'custom'].includes(currentSettings.exportSpeed)
                ? currentSettings.exportSpeed
                : 'standard';
            customDelaySec.value = currentSettings.customDelaySec || 5;
            customSpeedRows.classList.toggle('hidden', exportSpeed.value !== 'custom');
            postSafetyBreakEnabled.checked = currentSettings.postSafetyBreakEnabled === true;
            postSafetyBreakMin.value = currentSettings.postSafetyBreakMin ?? 3;
            postSafetyBreakEvery.value = currentSettings.postSafetyBreakEvery ?? 20;
            userExportSpeed.value = ['turbo', 'fast', 'standard', 'careful', 'turtle', 'custom'].includes(currentSettings.userExportSpeed)
                ? currentSettings.userExportSpeed
                : 'standard';
            userCustomDelaySec.value = currentSettings.userCustomDelaySec || 5;
            userCustomSpeedRows.classList.toggle('hidden', userExportSpeed.value !== 'custom');
            userSafetyBreakEnabled.checked = currentSettings.userSafetyBreakEnabled === true;
            userSafetyBreakMin.value = currentSettings.userSafetyBreakMin ?? 3;
            userSafetyBreakEvery.value = currentSettings.userSafetyBreakEvery ?? 20;
            syncSafetyBreakVisibility();
            includeAboutAccountDetails.checked =
                currentSettings.includeAboutAccountDetails === true;
            aboutAccountSpeed.value = ['turbo', 'fast', 'standard', 'careful', 'turtle', 'custom']
                .includes(currentSettings.aboutAccountSpeed)
                ? currentSettings.aboutAccountSpeed
                : 'standard';
            aboutAccountCustomBatchSize.value =
                currentSettings.aboutAccountCustomBatchSize || 5;
            aboutAccountMaxRetries.value =
                currentSettings.aboutAccountMaxRetries || 5;
            lastAcceptedAboutRetries = clampToInput(aboutAccountMaxRetries, 5);
            syncAboutAccountSpeedVisibility();
            autoExpireEnabled.checked = currentSettings.autoExpireEnabled !== false;
            autoExpireHours.value = currentSettings.autoExpireHours || 4;
            autoExpireRow.classList.toggle('hidden', !autoExpireEnabled.checked);
            if (ladybugEnabled) {
                ladybugEnabled.checked = currentSettings.ladybugEnabled !== false;
                window.XPorterLadybug?.setEnabled?.(ladybugEnabled.checked);
            }
            if (localizeExportHeaders) {
                localizeExportHeaders.checked = currentSettings.localizeExportHeaders === true;
            }
        }

        quantityLimit.addEventListener('change', () => {
            if (quantityLimit.value === 'custom') {
                customQuantityRow.classList.remove('hidden');
                customQuantity.focus();
            } else {
                customQuantityRow.classList.add('hidden');
            }
            saveSettingsDebounced();
        });

        autoExpireEnabled.addEventListener('change', () => {
            autoExpireRow.classList.toggle('hidden', !autoExpireEnabled.checked);
            saveSettingsDebounced();
        });

        if (ladybugEnabled) {
            ladybugEnabled.addEventListener('change', () => {
                window.XPorterLadybug?.setEnabled?.(ladybugEnabled.checked);
                saveSettingsDebounced();
            });
        }

        // Clamp a typed number input to its own min/max attributes.
        function clampToInput(el, fallback) {
            const parsed = parseInt(el.value, 10);
            const value = Number.isFinite(parsed) ? parsed : fallback;
            const min = parseInt(el.min, 10);
            const max = parseInt(el.max, 10);
            return Math.max(Number.isFinite(min) ? min : value, Math.min(Number.isFinite(max) ? max : value, value));
        }

        function clampDecimalInput(el, fallback) {
            const parsed = parseLocalizedDecimal(el.value, fallback);
            const min = parseLocalizedDecimal(el.dataset.min, parsed);
            const max = parseLocalizedDecimal(el.dataset.max, parsed);
            return Math.max(min, Math.min(max, parsed));
        }

        function syncAboutAccountSpeedVisibility() {
            aboutAccountOptions.classList.toggle(
                'hidden',
                !includeAboutAccountDetails.checked
            );
            aboutAccountCustomRows.classList.toggle(
                'hidden',
                !includeAboutAccountDetails.checked || aboutAccountSpeed.value !== 'custom'
            );
        }

        function syncSafetyBreakVisibility() {
            postSafetyBreakRows.classList.toggle('hidden', !postSafetyBreakEnabled.checked);
            userSafetyBreakRows.classList.toggle('hidden', !userSafetyBreakEnabled.checked);
            postSafetyBreakEnabled.setAttribute(
                'aria-expanded',
                String(postSafetyBreakEnabled.checked)
            );
            userSafetyBreakEnabled.setAttribute(
                'aria-expanded',
                String(userSafetyBreakEnabled.checked)
            );
        }

        const saveSettingsDebounced = debounce(async () => {
            let qLimit;
            if (quantityLimit.value === 'custom') {
                // Empty/0 custom value must keep the previous limit — never
                // silently persist 0 (= Unlimited).
                const parsed = parseInt(customQuantity.value, 10);
                qLimit = (parsed > 0) ? parsed : (currentSettings.quantityLimit ?? 500);
            } else {
                qLimit = parseInt(quantityLimit.value, 10) || 0;
            }
            const nextSettings = {
                postSelectionVersion: 1,
                includeOriginalPosts: includeOriginalPosts.checked,
                includeQuotes: includeQuotes.checked,
                includeReplies: includeReplies.checked,
                includeRetweets: includeRetweets.checked,
                includeArticles: includeArticles.checked,
                includeBookmarkReplyContext: includeBookmarkReplyContext.checked,
                includeBookmarkArticles: includeBookmarkArticles.checked,
                quantityLimit: qLimit,
                exportSpeed: exportSpeed.value || 'standard',
                customDelaySec: clampDecimalInput(customDelaySec, 5),
                postSafetyBreakEnabled: postSafetyBreakEnabled.checked,
                postSafetyBreakMin: clampDecimalInput(postSafetyBreakMin, 3),
                postSafetyBreakEvery: clampToInput(postSafetyBreakEvery, 20),
                userExportSpeed: userExportSpeed.value || 'standard',
                userCustomDelaySec: clampDecimalInput(userCustomDelaySec, 5),
                userSafetyBreakEnabled: userSafetyBreakEnabled.checked,
                userSafetyBreakMin: clampDecimalInput(userSafetyBreakMin, 3),
                userSafetyBreakEvery: clampToInput(userSafetyBreakEvery, 20),
                includeAboutAccountDetails: includeAboutAccountDetails.checked,
                aboutAccountSpeed: aboutAccountSpeed.value || 'standard',
                aboutAccountCustomBatchSize: clampToInput(aboutAccountCustomBatchSize, 5),
                aboutAccountMaxRetries: clampToInput(aboutAccountMaxRetries, 5),
                autoExpireEnabled: autoExpireEnabled.checked,
                autoExpireHours: clampToInput(autoExpireHours, 4),
                ladybugEnabled: ladybugEnabled ? ladybugEnabled.checked : true,
                localizeExportHeaders: localizeExportHeaders ? localizeExportHeaders.checked : false
            };
            // Send only values that this UI actually changed. A second open surface
            // may have updated another setting since our initial GET_SETTINGS; a
            // full stale snapshot would roll that newer value back.
            const patch = {};
            for (const [key, value] of Object.entries(nextSettings)) {
                if (currentSettings[key] !== value) patch[key] = value;
            }
            if (Object.keys(patch).length > 0) {
                return await persistSettingsPatch(currentSettings, patch);
            }
            return { success: true };
        }, 500);

        if (localizeExportHeaders) {
            localizeExportHeaders.addEventListener('change', saveSettingsDebounced);
        }

        exportSpeed.addEventListener('change', () => {
            customSpeedRows.classList.toggle('hidden', exportSpeed.value !== 'custom');
        });
        userExportSpeed.addEventListener('change', () => {
            userCustomSpeedRows.classList.toggle('hidden', userExportSpeed.value !== 'custom');
        });
        [postSafetyBreakEnabled, userSafetyBreakEnabled].forEach((control) => {
            control.addEventListener('change', syncSafetyBreakVisibility);
        });
        includeAboutAccountDetails.addEventListener('change', () => {
            if (!includeAboutAccountDetails.checked) {
                syncAboutAccountSpeedVisibility();
                saveSettingsDebounced();
                return;
            }

            // Revert until the consequence is explicitly confirmed. This prevents
            // the debounced settings save from enabling expensive requests behind
            // a dismissed warning.
            includeAboutAccountDetails.checked = false;
            syncAboutAccountSpeedVisibility();
            openAboutRiskDialog('enable', {
                trigger: includeAboutAccountDetails,
                onConfirm() {
                    includeAboutAccountDetails.checked = true;
                    syncAboutAccountSpeedVisibility();
                    saveSettingsDebounced();
                },
                onCancel() {}
            });
        });
        aboutAccountSpeed.addEventListener('change', syncAboutAccountSpeedVisibility);
        aboutAccountMaxRetries.addEventListener('change', () => {
            const nextRetries = clampToInput(aboutAccountMaxRetries, 5);
            aboutAccountMaxRetries.value = String(nextRetries);
            if (nextRetries > ABOUT_RETRY_WARNING_THRESHOLD &&
                nextRetries !== lastAcceptedAboutRetries) {
                // Unconfirmed values cannot enter another control's pending autosave.
                aboutAccountMaxRetries.value = String(lastAcceptedAboutRetries);
                openAboutRiskDialog('retries', {
                    trigger: aboutAccountMaxRetries,
                    onConfirm() {
                        lastAcceptedAboutRetries = nextRetries;
                        aboutAccountMaxRetries.value = String(nextRetries);
                        saveSettingsDebounced();
                    },
                    onCancel() {
                        aboutAccountMaxRetries.value = String(lastAcceptedAboutRetries);
                    }
                });
                return;
            }
            lastAcceptedAboutRetries = nextRetries;
            saveSettingsDebounced();
        });

        [includeOriginalPosts, includeQuotes, includeReplies, includeRetweets, includeArticles,
            includeBookmarkReplyContext, includeBookmarkArticles,
            quantityLimit, exportSpeed, customQuantity, autoExpireHours,
            customDelaySec, postSafetyBreakEnabled, postSafetyBreakMin, postSafetyBreakEvery,
            userExportSpeed, userCustomDelaySec, userSafetyBreakEnabled,
            userSafetyBreakMin, userSafetyBreakEvery,
            aboutAccountSpeed, aboutAccountCustomBatchSize].forEach(el => {
            el.addEventListener('change', saveSettingsDebounced);
        });
        customQuantity.addEventListener('input', saveSettingsDebounced);
        postTypeControls.forEach(control => {
            control.addEventListener('change', syncPostSelectionUI);
        });

        return Object.freeze({
            flush: saveSettingsDebounced.flush,
            validatePostSelection() {
                if (syncPostSelectionUI() > 0) return true;
                postSelectionPanel.scrollIntoView({ block: 'nearest' });
                showToast(t('postSelectionRequired'), 'error');
                return false;
            }
        });
    }

    root.XPorterSettingsForm = Object.freeze({ mount });
})(globalThis);
