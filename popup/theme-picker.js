// The picker changes only the selected preset and its light/dark mode.
function mountThemePicker({ currentSettings, t, showToast }) {
    const dialog = document.getElementById('themePicker');
    const options = document.getElementById('themePickerOptions');
    const trigger = document.getElementById('themeToggle');
    const settingsTrigger = document.getElementById('openThemePicker');
    const close = document.getElementById('closeThemePicker');
    let saving = false;
    let opener = trigger;
    const paletteIcon = '<svg data-tabler-icon="palette" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 21a9 9 0 0 1 0 -18c4.97 0 9 3.582 9 8c0 1.06 -.474 2.078 -1.318 2.828c-.844 .75 -1.989 1.172 -3.182 1.172h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25" /> <path d="M7.5 10.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /> <path d="M11.5 7.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /> <path d="M15.5 10.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /> </svg>';
    document.getElementById('themeIcon').innerHTML = paletteIcon;
    document.getElementById('themeSettingsIcon').innerHTML = paletteIcon;

    const closePicker = () => window.XPorterMotion
        ? XPorterMotion.closeDialog(dialog) : dialog.close();
    function markSelected(id) {
        for (const button of options.querySelectorAll('.theme-card')) {
            button.setAttribute('aria-pressed', String(button.dataset.preset === id));
            button.disabled = saving;
        }
    }
    async function choose(preset) {
        if (saving) return;
        if (XPorterThemes.resolve(currentSettings).id === preset.id) { closePicker(); return; }
        saving = true;
        const patch = { themePreset: preset.id, theme: preset.mode };
        const preview = () => {
            XPorterThemes.apply(document.body, patch);
            markSelected(preset.id);
        };
        // The crossfade applies the preview asynchronously; save only after it.
        if (window.XPorterMotion) await XPorterMotion.viewTransition(preview);
        else preview();
        let result;
        try {
            result = await persistSettingsPatch(currentSettings, patch);
        } catch (_) {
            result = { success: false, error: 'STORAGE_FULL' };
        }
        saving = false;
        const selected = XPorterThemes.apply(document.body, currentSettings);
        markSelected(selected.id);
        if (result?.success !== true) {
            showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
        } else {
            closePicker();
        }
    }
    function render() {
        const focusedId = options.contains(document.activeElement) ? document.activeElement.dataset.preset : null;
        options.replaceChildren();
        for (const mode of ['dark', 'light']) {
            const section = document.createElement('section');
            section.className = 'theme-picker-group';
            const heading = document.createElement('h3');
            heading.id = `theme-group-${mode}`;
            heading.textContent = t(mode === 'dark' ? 'themePickerDark' : 'themePickerLight');
            const grid = document.createElement('div');
            grid.className = 'theme-picker-grid';
            grid.setAttribute('role', 'group');
            grid.setAttribute('aria-labelledby', heading.id);
            for (const preset of XPorterThemes.presets.filter(item => item.mode === mode)) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'theme-card';
                button.dataset.preset = preset.id;
                const name = t(preset.key);
                button.setAttribute('aria-label', name);
                for (const [key, value] of Object.entries(preset.preview)) {
                    button.style.setProperty(`--preview-${key}`, value);
                }
                const miniature = document.createElement('span');
                miniature.className = 'theme-mini';
                miniature.setAttribute('aria-hidden', 'true');
                miniature.innerHTML = '<span class="theme-mini-header"><i></i><i></i></span><span class="theme-mini-panel"><span class="theme-mini-row"><i></i><b>✓</b></span><span class="theme-mini-row"><i></i><b>✓</b></span></span><span class="theme-mini-action">▶</span>';
                const label = document.createElement('span');
                label.className = 'theme-card-name';
                label.textContent = name;
                button.append(miniature, label);
                button.addEventListener('click', () => choose(preset));
                grid.append(button);
            }
            section.append(heading, grid);
            options.append(section);
        }
        markSelected(XPorterThemes.resolve(currentSettings).id);
        if (focusedId) options.querySelector(`[data-preset="${focusedId}"]`)?.focus({ preventScroll: true });
    }
    function open(event) {
        if (dialog.open) return;
        opener = event.currentTarget;
        render();
        dialog.showModal();
        const selected = options.querySelector('[aria-pressed="true"]');
        selected?.focus({ preventScroll: true });
        selected?.scrollIntoView({ block: 'nearest' });
    }
    trigger.addEventListener('click', open);
    settingsTrigger.addEventListener('click', open);
    close.addEventListener('click', closePicker);
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        closePicker();
    });
    dialog.addEventListener('close', () => opener.focus({ preventScroll: true }));
    dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right ||
            event.clientY < bounds.top || event.clientY > bounds.bottom) closePicker();
    });
    options.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        const buttons = [...options.querySelectorAll('.theme-card')];
        const index = buttons.indexOf(document.activeElement);
        if (index < 0 || saving) return;
        event.preventDefault();
        const rtl = document.documentElement.dir === 'rtl';
        const delta = event.key === 'ArrowUp' ? -3 : event.key === 'ArrowDown' ? 3 :
            (event.key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1);
        buttons[(index + delta + buttons.length) % buttons.length].focus();
    });
    new MutationObserver(() => { if (dialog.open) render(); }).observe(document.documentElement,
        { attributes: true, attributeFilter: ['lang'] });
}
