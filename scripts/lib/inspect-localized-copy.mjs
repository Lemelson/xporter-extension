// Includes glyph bounds and clipping ancestors, not just document.scrollWidth:
// overflow:hidden can hide a translated label without enlarging the page.
export function inspectCopy() {
    const problems = [];
    const visible = el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        !el.closest('.sr-only, .xporter-counter-accessible, .xporter-digit');
    const name = el => el.id || el.dataset.i18n || el.className || el.tagName;
    if (document.documentElement.scrollWidth > innerWidth + 1) {
        problems.push({ kind: 'page-overflow', width: document.documentElement.scrollWidth, viewport: innerWidth });
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
        const el = node.parentElement;
        if (!el || !node.textContent.trim() || !visible(el) || el.closest('script, style, option, svg')) continue;
        // Account names and handles are external content with intentional truncation.
        if (el.closest('.account-name, .account-handle, .history-name, .history-handle')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
            if (rect.width <= 0) continue;
            let issue = null;
            if (rect.left < -1 || rect.right > innerWidth + 1) issue = 'text-outside-window';
            for (let ancestor = el; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
                const style = getComputedStyle(ancestor);
                const box = ancestor.getBoundingClientRect();
                if (style.overflowX === 'hidden' || style.overflowX === 'clip') {
                    if (rect.left < box.left - 1 || rect.right > box.right + 1) issue = 'clipped-text';
                }
                // A closed accordion is intentionally hidden, not a clipped translation.
                if (style.overflowY === 'hidden' && !ancestor.classList.contains('detail-body')) {
                    if (rect.top < box.top - 2 || rect.bottom > box.bottom + 2) issue = 'clipped-text-height';
                }
            }
            if (issue) {
                problems.push({ kind: issue, element: name(el), text: node.textContent.trim(),
                    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
                break;
            }
        }
    }
    const canvas = document.createElement('canvas');
    const measure = canvas.getContext('2d');
    for (const select of document.querySelectorAll('select')) {
        if (!visible(select)) continue;
        const style = getComputedStyle(select);
        measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const available = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        for (const option of select.options) {
            const needed = measure.measureText(option.textContent).width;
            if (needed > available + 1) problems.push({ kind: 'select-truncation', element: name(select),
                key: option.dataset.i18n, text: option.textContent, needed: Math.ceil(needed), available });
        }
    }
    return problems;
}

