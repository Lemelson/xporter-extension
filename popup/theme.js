// XPorter Popup — Theme Module
// SVG icon templates, theme initialization and appearance settings

const ICONS = {
    circleCheck: '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
    // Tabler Icons, MIT: https://github.com/tabler/tabler-icons/blob/main/icons/outline/player-stop.svg
    playerStop: '<svg class="icon stopped-state-icon" data-tabler-icon="player-stop" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -10"/></svg>',
    // Tabler Icons, MIT: https://github.com/tabler/tabler-icons/blob/main/icons/outline/player-play.svg
    playerPlay: '<svg class="icon resumable-state-icon" data-tabler-icon="player-play" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 4v16l13 -8l-13 -8"/></svg>',
    rateLimit: '<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
    safetyBreak: '<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M10 9v6"/><path d="M14 9v6"/></svg>'
};

/**
 * Initialize the theme based on saved settings.
 * Returns the resolved theme mode ('light' or 'dark'). The header icon is the
 * theme picker's palette, owned by theme-picker.js.
 */
function initTheme(savedTheme) {
    const isLight = savedTheme === 'light';
    document.body.classList.toggle('light', isLight);
    return isLight ? 'light' : 'dark';
}

// Appearance owns only its appearance keys; it never saves a stale export-settings form.
function mountAppearanceSettings({ currentSettings, t, showToast }) {
    const scale = document.getElementById('uiScale');
    const textScale = document.getElementById('textScale');
    const sliders = [scale, textScale, document.getElementById('popupWidth'), document.getElementById('popupHeight')];
    const controls = sliders;
    function renderScale(control, value) {
        document.getElementById(`${control.id}Value`).textContent = `${value}%`;
        control.setAttribute('aria-valuetext', `${value}%`);
        const progress = (value - Number(control.min)) / (Number(control.max) - Number(control.min)) * 100;
        control.style.setProperty('--range-progress', `${progress}%`);
    }
    function render() {
        const appearance = XPorterUIAppearance.apply(document.body, currentSettings);
        for (const control of sliders) {
            control.value = String(appearance[control.id]);
            renderScale(control, appearance[control.id]);
        }
    }
    render();
    async function save(event) {
        const control = event.currentTarget;
        const previousTop = control.getBoundingClientRect().top;
        const restoreKeyboardFocus = document.activeElement === control && document.body.dataset.inputModality === 'keyboard';
        controls.forEach(element => { element.disabled = true; });
        const patch = { [control.id]: Number(control.value) };
        const result = await persistSettingsPatch(currentSettings, patch);
        render();
        controls.forEach(element => { element.disabled = false; });
        if (restoreKeyboardFocus) control.focus({ preventScroll: true });
        const scroller = control.closest('.tab-content');
        scroller.scrollTop += (control.getBoundingClientRect().top - previousTop) / (Number(scale.value) / 100);
        if (result?.success !== true) {
            showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
        }
    }
    for (const control of sliders) {
        control.addEventListener('change', save);
        control.addEventListener('input', () => {
            const value = Number(control.value);
            renderScale(control, value);
            // Resizing the window during a drag moves the track under the pointer.
            // Preview text immediately; apply interface dimensions on release.
            if (control === textScale) {
                XPorterUIAppearance.apply(document.body, { ...currentSettings, textScale: value });
            }
        });
    }
}
