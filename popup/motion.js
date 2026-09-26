// Popup motion: short, interruptible transitions layered over state changes
// the other popup modules already make. Nothing here owns state; every effect
// is decorative, mostly transform/opacity, and is skipped entirely when the
// OS asks for reduced motion (macOS "Reduce motion", Windows "Animation
// effects" off). Home's intrinsic height sizes the native popup window, so
// Home measurement uses `withFinalLayout`: the window takes its final size at
// once while disclosures ease open or closed inside it.
(function (root) {
    'use strict';

    const reduceQuery = root.matchMedia?.('(prefers-reduced-motion: reduce)');
    const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
    const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)';
    const EASE_SPRING = 'cubic-bezier(0.34, 1.35, 0.64, 1)';
    const EASE_EXIT = 'cubic-bezier(0.4, 0, 1, 1)';

    // Programmatic changes during initial rendering must not replay as motion.
    let armed = false;
    let suppressHomeRevealUntil = 0;
    let lastMode = null;

    function allowed() {
        return !reduceQuery?.matches && typeof Element.prototype.animate === 'function';
    }

    function play(element, keyframes, options) {
        if (!element || !allowed()) return null;
        try {
            return element.animate(keyframes, { easing: EASE_OUT, ...options });
        } catch (_) {
            return null; // Unsupported property or pseudo-element: stay static.
        }
    }

    function cancelOwn(element) {
        element.getAnimations?.().forEach(animation => {
            if (animation.id === 'xp-motion') animation.cancel();
        });
    }

    function tagged(animation) {
        if (animation) animation.id = 'xp-motion';
        return animation;
    }

    // ==================== Tabs ====================
    // The indicator glides from the previous tab while the new panel slides
    // in from the side the user moved towards (mirrored for RTL).
    function tabChanged(previousTab, nextTab, panel) {
        if (!previousTab || previousTab === nextTab || !allowed()) return;
        const center = tab => tab.offsetLeft + tab.offsetWidth / 2;
        const dx = center(previousTab) - center(nextTab);
        const base = getComputedStyle(nextTab, '::after').transform;
        const baseTransform = base && base !== 'none' ? base : '';
        play(nextTab, [
            { transform: `translateX(${dx}px) ${baseTransform} scaleX(1)` },
            { transform: `translateX(${dx * 0.4}px) ${baseTransform} scaleX(1.8)`, offset: 0.35 },
            { transform: `${baseTransform} scaleX(1)` }
        ], { duration: 380, pseudoElement: '::after' });

        const icon = nextTab.querySelector('svg');
        if (nextTab.dataset.tab === 'settings') {
            play(icon, [{ transform: 'rotate(-90deg)' }, { transform: 'rotate(0deg)' }],
                { duration: 520 });
        } else {
            play(icon, [{ transform: 'scale(0.78)' }, { transform: 'scale(1)' }],
                { duration: 380, easing: EASE_SPRING });
        }

        const tabs = [...nextTab.parentElement.querySelectorAll('.tab')];
        const forward = tabs.indexOf(nextTab) > tabs.indexOf(previousTab);
        const rtl = document.documentElement.dir === 'rtl';
        const offset = (forward !== rtl ? 1 : -1) * 16;
        cancelOwn(panel);
        tagged(play(panel, [
            { opacity: 0, transform: `translateX(${offset}px)` },
            { opacity: 1, transform: 'none' }
        ], { duration: 260 }));
    }

    // ==================== Height disclosures ====================
    function boxKeyframes(element) {
        const style = getComputedStyle(element);
        const open = { height: style.height };
        const closed = { height: '0px' };
        for (const side of ['Top', 'Bottom']) {
            for (const prop of [`padding${side}`, `margin${side}`, `border${side}Width`]) {
                if (parseFloat(style[prop])) {
                    open[prop] = style[prop];
                    closed[prop] = '0px';
                }
            }
        }
        return { open, closed };
    }

    function clipDuring(element, animation) {
        if (!animation) return;
        element.style.setProperty('overflow', 'clip');
        // Chrome < 90 has no overflow:clip; hidden still clips painting.
        if (getComputedStyle(element).overflow !== 'clip') element.style.setProperty('overflow', 'hidden');
        const release = () => element.style.removeProperty('overflow');
        animation.addEventListener('finish', release);
        animation.addEventListener('cancel', release);
    }

    function expand(element, duration = 280) {
        cancelOwn(element);
        releaseExit(element);
        const { open, closed } = boxKeyframes(element);
        const size = tagged(play(element, [closed, open], { duration }));
        clipDuring(element, size);
        tagged(play(element, [{ opacity: 0 }, { opacity: 1 }],
            { duration: duration - 60, delay: 60, fill: 'backwards', easing: 'ease-out' }));
    }

    // Content that arrives while (or just after) a disclosure opens would
    // otherwise snap the height at the end; continue from where it is.
    function regrow(element, duration = 260) {
        const from = getComputedStyle(element).height;
        element.getAnimations?.().forEach(animation => {
            if (animation.id === 'xp-motion' && animation.effect?.getKeyframes().some(frame => 'height' in frame)) {
                animation.cancel();
            }
        });
        const to = getComputedStyle(element).height;
        if (from === to) return;
        clipDuring(element, tagged(play(element, [{ height: from }, { height: to }], { duration })));
    }

    function collapse(element, display, duration = 220, onDone) {
        cancelOwn(element);
        holdVisible(element, display);
        const { open, closed } = boxKeyframes(element);
        const size = tagged(play(element, [open, closed], { duration, easing: EASE_IN_OUT }));
        clipDuring(element, size);
        tagged(play(element, [{ opacity: 1 }, { opacity: 0 }],
            { duration: duration * 0.7, easing: 'ease-in', fill: 'forwards' }));
        finishExit(element, size, onDone);
    }

    // ==================== Exit holding ====================
    // A hidden element leaves layout at once. To let it animate out, the
    // `motion-leaving` class (motion.css) keeps it displayed until the exit
    // ends; its `.hidden` state is already final for every other reader, and
    // Home measurement ignores leaving elements so the window sizes to the
    // final layout.
    const displays = new WeakMap();
    function rememberDisplay(element) {
        const display = getComputedStyle(element).display;
        if (display !== 'none') displays.set(element, display);
    }
    function holdVisible(element, display) {
        element.style.setProperty('--motion-display', display || displays.get(element) || 'block');
        element.style.setProperty('pointer-events', 'none');
        // Focus changes during closing can restyle the element while `.hidden`
        // applies, which would restart its CSS entry animation mid-exit.
        element.style.setProperty('animation', 'none');
        // Closed for assistive technology and focus from the first frame.
        if (!element.inert) {
            element.inert = true;
            element.dataset.motionInert = 'true';
        }
        if (!element.hasAttribute('aria-hidden')) {
            element.setAttribute('aria-hidden', 'true');
            element.dataset.motionAriaHidden = 'true';
        }
        element.classList.add('motion-leaving');
    }
    function releaseExit(element) {
        if (!element.classList.contains('motion-leaving')) return;
        element.style.removeProperty('--motion-display');
        element.style.removeProperty('pointer-events');
        element.style.removeProperty('animation');
        if (element.dataset.motionInert) element.inert = false;
        if (element.dataset.motionAriaHidden) element.removeAttribute('aria-hidden');
        delete element.dataset.motionInert;
        delete element.dataset.motionAriaHidden;
        cancelOwn(element);
        element.classList.remove('motion-leaving');
    }
    // Runs `measure` against the layout every running transition inside
    // `scope` is heading to: entrances are skipped to their end, leaving
    // elements are excluded by CSS. Nothing is painted in between.
    function withFinalLayout(scope, measure) {
        const running = scope.getAnimations?.({ subtree: true })
            .filter(animation => animation.id === 'xp-motion' && animation.playState === 'running') || [];
        const saved = running.map(animation => animation.currentTime);
        running.forEach(animation => {
            animation.currentTime = animation.effect.getComputedTiming().endTime;
        });
        try {
            return measure();
        } finally {
            running.forEach((animation, index) => { animation.currentTime = saved[index]; });
        }
    }
    function finishExit(element, animation, onDone) {
        if (!animation) {
            releaseExit(element);
            onDone?.();
            return;
        }
        animation.addEventListener('finish', () => {
            releaseExit(element);
            onDone?.();
        });
    }

    function fadeOut(element, keyframes, duration) {
        cancelOwn(element);
        holdVisible(element);
        const animation = tagged(play(element, keyframes,
            { duration, easing: EASE_EXIT, fill: 'forwards' }));
        finishExit(element, animation);
    }

    // ==================== Reveal kinds ====================
    const KINDS = {
        // Rows push the rest of the list smoothly in both directions.
        expand: { enter: element => expand(element), exit: element => collapse(element) },
        pop: {
            enter: element => tagged(play(element, [
                { opacity: 0, transform: 'scale(0.96)' },
                { opacity: 1, transform: 'none' }
            ], { duration: 240, easing: EASE_SPRING }))
        },
        menu: {
            exit: element => fadeOut(element, [
                { opacity: 1, transform: 'none' },
                { opacity: 0, transform: 'translateY(-4px) scale(0.98)' }
            ], 130)
        },
        dialog: {
            enter(element) {
                tagged(play(element, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' }));
                tagged(play(element.firstElementChild, [
                    { opacity: 0, transform: 'translateY(10px) scale(0.95)' },
                    { opacity: 1, transform: 'none' }
                ], { duration: 320, easing: EASE_SPRING }));
            },
            exit(element) {
                const card = element.firstElementChild;
                cancelOwn(card);
                tagged(play(card, [
                    { opacity: 1, transform: 'none' },
                    { opacity: 0, transform: 'translateY(6px) scale(0.97)' }
                ], { duration: 150, easing: EASE_EXIT, fill: 'forwards' }));
                fadeOut(element, [{ opacity: 1 }, { opacity: 0 }], 170);
            }
        }
    };

    const WATCHED = [
        ['#downloadBtn, #copyBtn, #newExportBtn, #targetAccountAvatar, #bookmarksAccountAvatar', 'pop'],
        ['#dateFields, #xlsxPhotoOptions, #accountContextNotice, #exportStatus, #postSelectionError,' +
            '#usernameError, #outputFormatHint, #downloadPlan, #resumeRow, #repliesFallbackActions,' +
            '#customQuantityRow, #customSpeedRows, #userCustomSpeedRows, #postSafetyBreakRows,' +
            '#userSafetyBreakRows, #aboutAccountOptions, #aboutAccountCustomRows, #autoExpireRow,' +
            '#historyList, #feedDbBody', 'expand'],
        ['#langDropdown', 'menu'],
        ['.risk-dialog-backdrop', 'dialog']
    ];

    const isHidden = classes => (classes || '').split(/\s+/).includes('hidden');
    const kindOf = new WeakMap();
    const homeContent = () => document.getElementById('homeContent');

    const observer = new MutationObserver(records => {
        const shown = [];
        for (const record of records) {
            const element = record.target;
            const wasHidden = isHidden(record.oldValue);
            const hiddenNow = element.classList.contains('hidden');
            if (wasHidden === hiddenNow) continue;
            const kind = KINDS[kindOf.get(element)];
            if (hiddenNow) {
                if (armed && kind.exit && displays.has(element)) kind.exit(element);
                else releaseExit(element);
            } else {
                releaseExit(element);
                rememberDisplay(element);
                if (armed && kind.enter) shown.push(element);
            }
        }
        const now = performance.now();
        for (const element of shown) {
            // A revealed ancestor already carries this element in.
            if (shown.some(other => other !== element && other.contains(element))) continue;
            if (now < suppressHomeRevealUntil && homeContent()?.contains(element)) continue;
            KINDS[kindOf.get(element)].enter(element);
        }
    });

    function watch() {
        for (const [selector, kind] of WATCHED) {
            document.querySelectorAll(selector).forEach(element => {
                kindOf.set(element, kind);
                rememberDisplay(element);
                observer.observe(element, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
            });
        }
    }

    // ==================== Export mode ====================
    // Switching mode re-lays the form below the selectors; the fields that
    // remain cascade in so the change reads as one transition, not a jump.
    function modeChanged(mode) {
        const previous = lastMode;
        lastMode = mode;
        if (!armed || previous === null || previous === mode || !allowed()) return;
        const content = homeContent();
        const anchor = content?.querySelector('.export-format-row');
        if (!anchor) return;
        suppressHomeRevealUntil = performance.now() + 80;
        const targets = [];
        for (let node = anchor.nextElementSibling; node; node = node.nextElementSibling) {
            if (node.offsetParent === null || node.classList.contains('hidden')) continue;
            if (node.id === 'postsOnlyOptions') {
                targets.push(...node.querySelectorAll('.post-selection-heading, .post-type-row, .post-selection-panel ~ *'));
            } else {
                targets.push(node);
            }
        }
        targets.slice(0, 9).forEach((node, index) => {
            cancelOwn(node);
            tagged(play(node, [
                { opacity: 0, transform: 'translateY(8px)' },
                { opacity: 1, transform: 'none' }
            ], { duration: 300, delay: index * 32, fill: 'backwards' }));
        });
    }

    // ==================== Accordions (About) ====================
    // `.detail-item.open` shows the body at full height; closing keeps it
    // displayed until the height reaches zero.
    function disclosureChanged(item, open) {
        const body = item.querySelector('.detail-body');
        if (!body || !allowed()) return;
        if (open) {
            releaseExit(body);
            expand(body, 300);
        } else {
            collapse(body, 'block', 240);
        }
    }

    // `<details>` hides its content natively. The summary click is handled
    // here so opening starts in the same task and closing waits until the
    // body has folded away; keyboard activation arrives as the same click.
    function mountDetails(details) {
        const summary = details.querySelector(':scope > summary');
        const body = summary?.nextElementSibling;
        if (!body) return;
        let closing = false;
        summary.addEventListener('click', event => {
            if (!allowed()) return;
            event.preventDefault();
            if (closing) return;
            if (!details.open) {
                details.open = true;
                expand(body, 300);
                return;
            }
            closing = true;
            details.classList.add('is-closing');
            collapse(body, getComputedStyle(body).display, 240, () => {
                closing = false;
                details.classList.remove('is-closing');
                details.open = false;
            });
        });
    }

    // ==================== Native dialog ====================
    function closeDialog(dialog, close = () => dialog.close()) {
        if (!dialog.open) return;
        if (!allowed() || dialog.dataset.motionClosing) {
            if (!dialog.dataset.motionClosing) close();
            return;
        }
        dialog.dataset.motionClosing = 'true';
        const animation = play(dialog, [
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: 'translateY(6px) scale(0.97)' }
        ], { duration: 150, easing: EASE_EXIT, fill: 'forwards' });
        const backdrop = play(dialog, [{ opacity: 1 }, { opacity: 0 }],
            { duration: 170, easing: EASE_EXIT, fill: 'forwards', pseudoElement: '::backdrop' });
        const done = () => {
            delete dialog.dataset.motionClosing;
            close();
            animation?.cancel();
            backdrop?.cancel();
        };
        if (animation) animation.addEventListener('finish', done);
        else done();
    }

    // ==================== Whole-view crossfade ====================
    // Theme and language changes repaint every surface at once; a snapshot
    // crossfade (Chrome 111+) hides the frame-by-frame recolour.
    function viewTransition(update) {
        if (!allowed() || typeof document.startViewTransition !== 'function' ||
            document.visibilityState !== 'visible') {
            return Promise.resolve(update());
        }
        let result;
        const transition = document.startViewTransition(() => {
            result = update();
            return result;
        });
        return transition.updateCallbackDone.then(() => result, () => result);
    }

    // ==================== Micro-interactions ====================
    function mountMicroInteractions() {
        document.addEventListener('change', event => {
            const input = event.target;
            if (!(input instanceof HTMLInputElement) || !input.closest('.post-choice')) return;
            const check = input.closest('label')?.querySelector('.post-choice-check');
            if (!check) return;
            play(check, [
                { transform: 'scale(0.8)' },
                { transform: 'scale(1.08)', offset: 0.55 },
                { transform: 'scale(1)' }
            ], { duration: 300, easing: 'ease-out' });
            if (input.checked && input.type === 'checkbox') {
                const base = getComputedStyle(check, '::after').transform;
                const tick = base && base !== 'none' ? base : '';
                play(check, [
                    { opacity: 0, transform: `${tick} scale(0.3)` },
                    { opacity: 1, transform: `${tick} scale(1)` }
                ], { duration: 280, pseudoElement: '::after', easing: EASE_SPRING });
            }
        });

        const count = document.getElementById('postSelectionCount');
        if (count) {
            let previous = count.textContent;
            new MutationObserver(() => {
                if (count.textContent === previous) return;
                previous = count.textContent;
                if (!armed) return;
                cancelOwn(count);
                tagged(play(count, [
                    { transform: 'scale(1)' },
                    { transform: 'scale(1.18)', offset: 0.4 },
                    { transform: 'scale(1)' }
                ], { duration: 320, easing: 'ease-out' }));
            }).observe(count, { childList: true, subtree: true });
        }

        document.querySelectorAll('details.appearance-settings').forEach(mountDetails);
        mountStatusTitle();
        mountActionIcons();
        mountHistoryCascade();
    }

    // A new status title (searching → exporting → done) replaces the old one
    // with a short rise; the completion check draws itself once.
    function mountStatusTitle() {
        const title = document.getElementById('statusText');
        if (!title) return;
        let previous = title.textContent;
        new MutationObserver(() => {
            const text = title.textContent;
            if (text === previous) return; // identical re-renders never replay
            previous = text;
            if (!armed || title.offsetParent === null) return;
            cancelOwn(title);
            tagged(play(title, [
                { opacity: 0, transform: 'translateY(5px)' },
                { opacity: 1, transform: 'none' }
            ], { duration: 280 }));
            const icon = title.querySelector('svg');
            if (!icon) return;
            play(icon, [
                { opacity: 0, transform: 'scale(0.4) rotate(-45deg)' },
                { opacity: 1, transform: 'none' }
            ], { duration: 460, easing: EASE_SPRING });
            const strokes = [...icon.querySelectorAll('path, circle, polyline')];
            const tick = strokes[strokes.length - 1];
            if (strokes.length > 1 && typeof tick?.getTotalLength === 'function') {
                const length = tick.getTotalLength();
                tick.style.strokeDasharray = String(length);
                const draw = play(tick, [{ strokeDashoffset: length }, { strokeDashoffset: 0 }],
                    { duration: 360, delay: 180, fill: 'backwards', easing: 'ease-out' });
                const clear = () => tick.style.removeProperty('stroke-dasharray');
                if (draw) {
                    draw.addEventListener('finish', clear);
                    draw.addEventListener('cancel', clear);
                } else {
                    clear();
                }
            }
        }).observe(title, { childList: true, characterData: true, subtree: true });
    }

    // Each action's own glyph acknowledges the press in the direction of what
    // it does: download drops, resume and start move forward, new export turns.
    const ICON_MOTION = {
        startBtn: [{ transform: 'none' }, { transform: 'translateX(4px)', offset: 0.4 }, { transform: 'none' }],
        resumeBtn: [{ transform: 'none' }, { transform: 'translateX(4px)', offset: 0.4 }, { transform: 'none' }],
        downloadBtn: [{ transform: 'none' }, { transform: 'translateY(4px)', offset: 0.4 }, { transform: 'none' }],
        copyBtn: [{ transform: 'none' }, { transform: 'scale(0.8)', offset: 0.4 }, { transform: 'none' }],
        newExportBtn: [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
        stopBtn: [{ transform: 'none' }, { transform: 'rotate(90deg) scale(0.85)', offset: 0.5 }, { transform: 'none' }],
        themeToggle: [{ transform: 'none' }, { transform: 'rotate(-18deg)', offset: 0.3 },
            { transform: 'rotate(10deg)', offset: 0.65 }, { transform: 'none' }],
        openThemePicker: [{ transform: 'none' }, { transform: 'rotate(-18deg)', offset: 0.3 },
            { transform: 'rotate(10deg)', offset: 0.65 }, { transform: 'none' }]
    };
    function mountActionIcons() {
        document.addEventListener('click', event => {
            const button = event.target.closest?.('button');
            const keyframes = button && ICON_MOTION[button.id];
            if (!keyframes || button.disabled) return;
            const icon = button.querySelector('svg');
            if (!icon) return;
            icon.style.transformOrigin = 'center';
            icon.style.transformBox = 'fill-box';
            cancelOwn(icon);
            tagged(play(icon, keyframes, {
                duration: button.id === 'newExportBtn' ? 560 : 420,
                easing: button.id === 'newExportBtn' ? EASE_OUT : 'ease-out'
            }));
        }, true);
    }

    // Opening export history lets its entries arrive in sequence.
    function mountHistoryCascade() {
        const list = document.getElementById('historyList');
        if (!list) return;
        let openedAt = 0;
        new MutationObserver(records => {
            if (records.some(record => record.type === 'attributes')) {
                if (!list.classList.contains('hidden')) openedAt = performance.now();
                return;
            }
            if (!armed || performance.now() - openedAt > 700) return;
            regrow(list);
            [...list.querySelectorAll(':scope > .history-card')].slice(0, 6).forEach((card, index) => {
                tagged(play(card, [
                    { opacity: 0, transform: 'translateY(6px)' },
                    { opacity: 1, transform: 'none' }
                ], { duration: 280, delay: 60 + index * 40, fill: 'backwards' }));
            });
        }).observe(list, { childList: true, attributes: true, attributeFilter: ['class'] });
    }

    function arm() {
        if (armed) return;
        armed = true;
        document.body.classList.add('motion-ready');
    }

    watch();
    mountMicroInteractions();
    document.addEventListener('xporter:ready', () => requestAnimationFrame(arm), { once: true });
    // A failed initialisation must not leave the popup permanently static.
    setTimeout(arm, 3000);

    root.XPorterMotion = Object.freeze({
        tabChanged, modeChanged, disclosureChanged, closeDialog, viewTransition, withFinalLayout
    });
})(globalThis);
