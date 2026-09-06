// Shared, dependency-free digit reels for the popup and the in-page status.
// Accessible text and actual values update immediately; only glyphs animate.
(function (root) {
    'use strict';
    const values = new WeakMap();
    const styledDocuments = new WeakSet();
    function render(element, text, { animate = true } = {}) {
        text = String(text);
        const previous = values.get(element);
        if (previous === text && animate) return;
        values.set(element, text);
        element.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
        const doc = element.ownerDocument;
        if (!styledDocuments.has(doc)) {
            const style = doc.createElement('style');
            style.id = 'xporter-counter-style';
            style.textContent = `
                .xporter-counter-accessible { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
                .xporter-number-run { display:inline-block; direction:ltr; unicode-bidi:isolate; white-space:nowrap; }
                .xporter-digit { display:inline-block; width:.62em; height:1.2em; line-height:1.2; overflow:hidden; vertical-align:-.2em; text-align:center; font-variant-numeric:tabular-nums; }
                .xporter-digit-strip { display:block; position:relative; }
                .xporter-digit-strip::before { content:attr(data-previous); position:absolute; inset-inline:0; top:-100%; }
            `;
            doc.head.append(style);
            styledDocuments.add(doc);
        }
        const visual = doc.createElement('span');
        visual.setAttribute('aria-hidden', 'true');
        element.setAttribute('aria-label', text);
        const oldRuns = previous?.match(/[0-9٠-٩۰-۹]+/g) || [];
        let runIndex = 0;
        const reels = [];
        for (const part of text.split(/([0-9٠-٩۰-۹]+)/)) {
            if (!/^[0-9٠-٩۰-۹]+$/.test(part)) { visual.append(part); continue; }
            const run = doc.createElement('span');
            run.className = 'xporter-number-run';
            const old = (oldRuns[runIndex++] || '').padStart(part.length, ' ');
            for (let index = 0; index < part.length; index++) {
                const digit = doc.createElement('span');
                digit.className = 'xporter-digit';
                const strip = doc.createElement('span');
                strip.className = 'xporter-digit-strip';
                strip.textContent = part[index];
                const prior = old[old.length - part.length + index] || ' ';
                if (prior !== part[index]) {
                    strip.dataset.previous = prior;
                    reels.push({ strip, index: part.length - index - 1 });
                }
                digit.append(strip);
                run.append(digit);
            }
            visual.append(run);
        }
        const accessible = doc.createElement('span');
        accessible.className = 'xporter-counter-accessible';
        accessible.textContent = text;
        element.replaceChildren(accessible, visual);
        if (animate && previous !== undefined &&
            !doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            for (const { strip, index } of reels) {
                strip.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }],
                    { duration: 420 + Math.min(index, 4) * 35, easing: 'cubic-bezier(.16,1,.3,1)' });
            }
        }
    }
    root.XPorterRollingCounter = Object.freeze({ render });
})(globalThis);
