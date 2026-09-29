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
    const EASE_POP = 'cubic-bezier(0.2, 1.4, 0.4, 1)';

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
        ['#downloadBtn, #copyBtn, #newExportBtn, #stopBtn, #targetAccountAvatar, #bookmarksAccountAvatar', 'pop'],
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
            if (closing) {
                // A second click while folding: the latest intent wins, and
                // the body grows back from wherever it is.
                closing = false;
                details.classList.remove('is-closing');
                const from = getComputedStyle(body);
                const height = from.height, opacity = from.opacity;
                releaseExit(body);
                clipDuring(body, tagged(play(body, [{ height }, { height: getComputedStyle(body).height }],
                    { duration: 260 })));
                tagged(play(body, [{ opacity }, { opacity: 1 }], { duration: 200 }));
                return;
            }
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
        mountTextSwap(document.getElementById('statusMessage'));
        mountTextSwap(document.querySelector('#downloadBtn [data-i18n="download"]'));
        mountStatusDot();
        mountRipples();
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
            if (strokes.length > 1) drawStroke(strokes[strokes.length - 1], { delay: 180 });
            const card = document.getElementById('exportStatus');
            if (card && !card.classList.contains('is-running') && !card.classList.contains('phase-stopped')) {
                glint(card.querySelector('.progress-bar'));
            }
        }).observe(title, { childList: true, characterData: true, subtree: true });
    }

    // Draws an SVG stroke from its start, as if written once.
    function drawStroke(path, { delay = 0, duration = 360 } = {}) {
        if (typeof path?.getTotalLength !== 'function') return;
        const length = path.getTotalLength();
        path.style.strokeDasharray = String(length);
        const draw = play(path, [{ strokeDashoffset: length }, { strokeDashoffset: 0 }],
            { duration, delay, fill: 'backwards', easing: 'ease-out' });
        const clear = () => path.style.removeProperty('stroke-dasharray');
        if (draw) {
            draw.addEventListener('finish', clear);
            draw.addEventListener('cancel', clear);
        } else {
            clear();
        }
    }

    // One pass of light across a finished progress bar.
    function glint(bar) {
        if (!bar || bar.offsetParent === null || !allowed()) return;
        const light = document.createElement('span');
        light.className = 'xp-glint';
        light.setAttribute('aria-hidden', 'true');
        bar.append(light);
        const animation = play(light, [{ transform: 'translateX(-120%)' }, { transform: 'translateX(320%)' }],
            { duration: 900, delay: 120, easing: 'cubic-bezier(0.45, 0, 0.2, 1)', fill: 'backwards' });
        if (animation) animation.addEventListener('finish', () => light.remove());
        else light.remove();
    }

    // Short status lines (and the Download label) replace their text with a
    // rise. Counting updates (countdowns, part numbers) never replay it.
    function mountTextSwap(element) {
        if (!element) return;
        const shape = text => text.replace(/[\d\s.,:/\u2026]+/g, '#');
        let previous = element.textContent;
        new MutationObserver(() => {
            const text = element.textContent;
            if (text === previous) return;
            const counting = shape(text) === shape(previous);
            previous = text;
            if (!armed || counting || element.offsetParent === null) return;
            cancelOwn(element);
            tagged(play(element, [
                { opacity: 0, transform: 'translateY(6px)' },
                { opacity: 1, transform: 'none' }
            ], { duration: 320 }));
        }).observe(element, { childList: true, characterData: true, subtree: true });
    }

    // The status dot answers a change of state (not every re-render).
    function mountStatusDot() {
        const dot = document.getElementById('statusIndicator');
        if (!dot) return;
        const colorOf = () => /status-([\w-]+)/.exec(dot.className)?.[1] || '';
        let previous = colorOf();
        new MutationObserver(() => {
            const color = colorOf();
            if (color === previous) return;
            previous = color;
            if (!armed || dot.offsetParent === null) return;
            play(dot, [
                { transform: 'scale(0.2)' },
                { transform: 'scale(1.45)', offset: 0.55 },
                { transform: 'scale(1)' }
            ], { duration: 460, easing: 'ease-out' });
        }).observe(dot, { attributes: true, attributeFilter: ['class'] });
    }

    // ==================== Download ====================
    // After the browser accepts the file, the arrow turns into a check for a
    // moment and the button pings once.
    function downloadDone(button) {
        if (!button || !armed || !allowed()) return;
        const icon = button.querySelector('svg:not(.xp-done-check)');
        if (!icon || button.querySelector('.xp-done-check')) return;
        const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        check.setAttribute('class', 'xp-done-check');
        check.setAttribute('viewBox', '0 0 24 24');
        check.setAttribute('aria-hidden', 'true');
        check.innerHTML = '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
        icon.style.display = 'none';
        icon.after(check);
        play(check, [{ transform: 'scale(0.5)', opacity: 0 }, { transform: 'none', opacity: 1 }],
            { duration: 380, easing: EASE_POP });
        drawStroke(check.firstChild, { delay: 60, duration: 320 });
        button.classList.remove('xp-ping');
        void button.offsetWidth;
        button.classList.add('xp-ping');
        button.addEventListener('animationend', () => button.classList.remove('xp-ping'), { once: true });
        const restore = () => {
            if (!check.isConnected) return;
            check.remove();
            icon.style.removeProperty('display');
            play(icon, [{ transform: 'translateY(-7px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
                { duration: 300, easing: EASE_OUT });
        };
        setTimeout(() => {
            const out = play(check, [{ transform: 'none', opacity: 1 }, { transform: 'scale(0.6)', opacity: 0 }],
                { duration: 160, easing: EASE_EXIT, fill: 'forwards' });
            if (out) out.addEventListener('finish', restore);
            else restore();
        }, 1400);
        // A new download never shows a stale check.
        new MutationObserver((_, watcher) => {
            if (!button.classList.contains('is-busy')) return;
            watcher.disconnect();
            restore();
        }).observe(button, { attributes: true, attributeFilter: ['class'] });
    }

    // A soft wave from the point of contact on primary and status actions.
    function mountRipples() {
        document.addEventListener('pointerdown', event => {
            const button = event.target.closest?.('.export-status .btn, #startBtn');
            if (!button || button.disabled || !allowed() || event.button !== 0) return;
            const rect = button.getBoundingClientRect();
            const zoom = button.offsetWidth ? rect.width / button.offsetWidth : 1;
            const x = (event.clientX - rect.left) / zoom, y = (event.clientY - rect.top) / zoom;
            const size = Math.hypot(Math.max(x, button.offsetWidth - x), Math.max(y, button.offsetHeight - y)) * 2;
            const ripple = document.createElement('span');
            ripple.className = 'xp-ripple';
            ripple.setAttribute('aria-hidden', 'true');
            ripple.style.cssText = `width:${size}px;height:${size}px;left:${x - size / 2}px;top:${y - size / 2}px`;
            button.append(ripple);
            const wave = play(ripple, [
                { transform: 'scale(0)', opacity: 0.28 },
                { transform: 'scale(1)', opacity: 0 }
            ], { duration: 620, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
            if (wave) wave.addEventListener('finish', () => ripple.remove());
            else ripple.remove();
        });
    }

    // ==================== Toasts ====================
    // Entering toasts rise with a small overshoot while earlier ones glide to
    // make room; the icon draws (success) or gives one shake (error).
    function slideFrom(elements, tops) {
        elements.forEach((element, index) => {
            const rect = element.getBoundingClientRect();
            const zoom = element.offsetHeight ? rect.height / element.offsetHeight : 1;
            const dy = (tops[index] - rect.top) / zoom;
            if (Math.abs(dy) < 0.5) return;
            play(element, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
                { duration: 380, composite: 'add' });
        });
    }
    function toastEnter(container, toast) {
        const earlier = [...container.children];
        const tops = allowed() ? earlier.map(element => element.getBoundingClientRect().top) : null;
        container.appendChild(toast);
        if (!tops) return;
        slideFrom(earlier, tops);
        play(toast, [
            { opacity: 0, transform: 'translateY(18px) scale(0.9)' },
            { opacity: 1, transform: 'none' }
        ], { duration: 520, easing: EASE_POP });
        const icon = toast.querySelector('.toast-icon svg');
        if (!icon) return;
        play(icon, [
            { opacity: 0, transform: 'scale(0.3) rotate(-40deg)' },
            { opacity: 1, transform: 'none' }
        ], { duration: 440, delay: 110, fill: 'backwards', easing: EASE_POP });
        if (toast.classList.contains('toast-success')) {
            drawStroke(icon.querySelector('path'), { delay: 260, duration: 340 });
        } else if (toast.classList.contains('toast-error')) {
            play(icon, [
                { transform: 'rotate(0deg)' }, { transform: 'rotate(-16deg)', offset: 0.2 },
                { transform: 'rotate(13deg)', offset: 0.45 }, { transform: 'rotate(-8deg)', offset: 0.7 },
                { transform: 'rotate(0deg)' }
            ], { duration: 460, delay: 560, easing: 'ease-in-out' });
        }
    }
    function toastLeave(toast) {
        if (!allowed()) {
            toast.classList.remove('toast-show');
            setTimeout(() => toast.remove(), 250);
            return;
        }
        const out = play(toast, [
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: 'translateY(10px) scale(0.94)' }
        ], { duration: 220, easing: EASE_EXIT, fill: 'forwards' });
        const remove = () => {
            const container = toast.parentElement;
            const rest = container ? [...container.children].filter(element => element !== toast) : [];
            const tops = rest.map(element => element.getBoundingClientRect().top);
            toast.remove();
            slideFrom(rest, tops);
        };
        if (out) out.addEventListener('finish', remove);
        else remove();
    }

    // ==================== Help ====================
    // Help grows out of its trigger, from above or below, and fades back.
    function helpShown(tooltip) {
        if (!allowed()) return;
        const reopening = tooltip.classList.contains('motion-leaving');
        const opacity = reopening ? getComputedStyle(tooltip).opacity : 0;
        releaseExit(tooltip);
        const below = tooltip.style.getPropertyValue('--help-placement') !== 'above';
        tooltip.style.transformOrigin = `var(--help-origin-x, 50%) ${below ? 'top' : 'bottom'}`;
        tagged(play(tooltip, [
            { opacity, transform: `translateY(${below ? -8 : 8}px) scale(0.92)` },
            { opacity: 1, transform: 'none' }
        ], { duration: 280, easing: 'cubic-bezier(0.2, 1.2, 0.4, 1)' }));
    }
    function helpHidden(tooltip, hide) {
        if (!allowed()) {
            hide();
            return;
        }
        cancelOwn(tooltip);
        holdVisible(tooltip, 'block');
        const below = tooltip.style.getPropertyValue('--help-placement') !== 'above';
        const out = tagged(play(tooltip, [
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: `translateY(${below ? -4 : 4}px) scale(0.97)` }
        ], { duration: 150, easing: EASE_EXIT, fill: 'forwards' }));
        finishExit(tooltip, out, hide);
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
        tabChanged, modeChanged, disclosureChanged, closeDialog, viewTransition, withFinalLayout,
        helpShown, helpHidden, toastEnter, toastLeave, downloadDone
    });
})(globalThis);
