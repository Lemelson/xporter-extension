'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { source } = require('./support.js');

function testThemeInitializationCanRevertToDark() {
    const classes = new Set(['light']);
    const context = vm.createContext({
        document: {
            body: {
                classList: {
                    toggle(name, enabled) {
                        if (enabled) classes.add(name);
                        else classes.delete(name);
                    }
                }
            }
        }
    });
    vm.runInContext(source('popup/theme.js'), context, { filename: 'popup/theme.js' });
    context.__icon = { innerHTML: '' };
    const mode = vm.runInContext('initTheme("dark", __icon)', context);
    assert.equal(mode, 'dark');
    assert.equal(classes.has('light'), false, 'restoring dark must remove a previously applied light class');

    classes.add('light');
    const defaultMode = vm.runInContext('initTheme(undefined, __icon)', context);
    assert.equal(defaultMode, 'dark');
    assert.equal(classes.has('light'), false, 'missing saved theme must default to dark');
}

async function testContentScriptDetectsSignedInAccountFromXNavigation() {
    const messages = [];
    const switcher = {
        // X's compact sidebar exposes no visible text in the switcher. The
        // signed-in display name remains available as the avatar alt text.
        innerText: '',
        querySelector(selector) {
            return selector === 'img'
                ? {
                    src: 'https://pbs.twimg.com/profile_images/123/avatar_normal.jpg',
                    alt: 'Lucas Strand'
                }
                : null;
        }
    };
    const profileLink = {
        getAttribute(name) {
            return name === 'href' ? '/bylemelson' : null;
        }
    };
    const document = {
        documentElement: {},
        body: {},
        querySelector(selector) {
            if (selector.includes('SideNav_AccountSwitcher_Button')) return switcher;
            if (selector.includes('AppTabBar_Profile_Link')) return profileLink;
            return null;
        },
        addEventListener() {}
    };
    const window = {
        location: {
            pathname: '/i/bookmarks',
            href: 'https://x.com/i/bookmarks',
            origin: 'https://x.com'
        },
        addEventListener() {},
        postMessage() {}
    };
    const context = vm.createContext({
        console,
        URL,
        document,
        window,
        setTimeout,
        clearTimeout,
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() {}
        },
        chrome: {
            runtime: {
                onMessage: { addListener() {} },
                sendMessage(message) {
                    messages.push(message);
                    return Promise.resolve({ success: true });
                }
            }
        }
    });
    vm.runInContext(source('content/content.js'), context, { filename: 'content/content.js' });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const accountMessage = messages.find((message) => message.type === 'SET_CURRENT_ACCOUNT');
    assert.deepEqual(JSON.parse(JSON.stringify(accountMessage?.account)), {
        name: 'Lucas Strand',
        username: 'bylemelson',
        avatarUrl: 'https://pbs.twimg.com/profile_images/123/avatar_normal.jpg'
    });
}

async function testContentScriptReturnsLiveTargetAndViewerAccounts() {
    let runtimeListener = null;
    const viewerSwitcher = {
        innerText: '',
        querySelector(selector) {
            return selector === 'img'
                ? {
                    src: 'https://pbs.twimg.com/profile_images/1/viewer_x96.jpg',
                    alt: 'Lucas Strand'
                }
                : null;
        }
    };
    const profileLink = {
        getAttribute(name) {
            return name === 'href' ? '/strndstein' : null;
        }
    };
    const targetAvatar = {
        src: 'https://pbs.twimg.com/profile_images/2/target_x96.jpg'
    };
    const targetTweet = {
        querySelector(selector) {
            if (selector === '[data-testid="User-Name"]') {
                return { innerText: 'Ohegao_sf\n@Oheva_sf' };
            }
            if (selector === '[data-testid="Tweet-User-Avatar"] img') {
                return targetAvatar;
            }
            return null;
        }
    };
    const document = {
        documentElement: {},
        body: {},
        querySelector(selector) {
            if (selector.includes('SideNav_AccountSwitcher_Button')) return viewerSwitcher;
            if (selector.includes('AppTabBar_Profile_Link')) return profileLink;
            if (selector === '[data-testid="UserName"]') return null;
            return null;
        },
        querySelectorAll(selector) {
            if (selector === 'article[data-testid="tweet"]') return [targetTweet];
            if (selector === '[data-testid^="UserAvatar-Container-"]') return [];
            return [];
        },
        addEventListener() {}
    };
    const window = {
        location: {
            pathname: '/Oheva_sf/status/2092143399465889810',
            href: 'https://x.com/Oheva_sf/status/2092143399465889810',
            origin: 'https://x.com'
        },
        addEventListener() {},
        postMessage() {}
    };
    const context = vm.createContext({
        console,
        URL,
        document,
        window,
        setTimeout,
        clearTimeout,
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() {}
        },
        chrome: {
            runtime: {
                onMessage: {
                    addListener(listener) {
                        runtimeListener = listener;
                    }
                },
                sendMessage() {
                    return Promise.resolve({ success: true });
                }
            }
        }
    });
    vm.runInContext(source('content/content.js'), context, { filename: 'content/content.js' });

    let response = null;
    const keepsChannelOpen = runtimeListener(
        { type: 'GET_ACCOUNT_CONTEXT' },
        {},
        (value) => { response = value; }
    );

    assert.equal(keepsChannelOpen, true);
    assert.deepEqual(JSON.parse(JSON.stringify(response)), {
        currentAccount: {
            name: 'Lucas Strand',
            username: 'strndstein',
            avatarUrl: 'https://pbs.twimg.com/profile_images/1/viewer_x96.jpg'
        },
        targetAccount: {
            name: 'Ohegao_sf',
            username: 'Oheva_sf',
            avatarUrl: 'https://pbs.twimg.com/profile_images/2/target_x96.jpg',
            isCurrentAccount: false
        }
    });
}

async function testAcknowledgementCountdownRequiresFiveFullTicks() {
    const scheduled = [];
    const cleared = [];
    const button = {
        disabled: false,
        textContent: '',
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        removeAttribute(name) { delete this.attributes[name]; }
    };
    const context = vm.createContext({ globalThis: {}, window: {} });
    context.window = context.globalThis;
    vm.runInContext(source('popup/acknowledgement-timer.js'), context, {
        filename: 'popup/acknowledgement-timer.js'
    });

    const timer = context.globalThis.XPorterAcknowledgementTimer.start(button, {
        seconds: 5,
        readyLabel: 'I understand',
        waitingLabel: (label, seconds) => `${label} (${seconds})`,
        schedule(callback) {
            scheduled.push(callback);
            return scheduled.length;
        },
        cancelSchedule(id) {
            cleared.push(id);
        }
    });

    assert.equal(button.disabled, true);
    assert.equal(button.textContent, 'I understand (5)');
    assert.equal(button.attributes['aria-disabled'], 'true');
    scheduled.shift()();
    assert.equal(button.textContent, 'I understand (4)');
    assert.equal(button.disabled, true);
    scheduled.shift()();
    assert.equal(button.textContent, 'I understand (3)');
    assert.equal(button.disabled, true);
    scheduled.shift()();
    assert.equal(button.textContent, 'I understand (2)');
    assert.equal(button.disabled, true);
    scheduled.shift()();
    assert.equal(button.textContent, 'I understand (1)');
    assert.equal(button.disabled, true);
    scheduled.shift()();
    assert.equal(button.textContent, 'I understand');
    assert.equal(button.disabled, false);
    assert.equal(button.attributes['aria-disabled'], undefined);

    const pendingTimer = context.globalThis.XPorterAcknowledgementTimer.start(button, {
        seconds: 5,
        readyLabel: 'I understand',
        schedule(callback) {
            scheduled.push(callback);
            return 99;
        },
        cancelSchedule(id) {
            cleared.push(id);
        }
    });
    pendingTimer.cancel();
    assert(cleared.length >= 1);
    timer.cancel();
}

async function testLocaleLoadsShareRequestsAndRetryFailures() {
    const requests = [];
    let russianAttempts = 0;
    const context = vm.createContext({
        console: { warn() {} },
        chrome: { runtime: { getURL: value => value } },
        async fetch(url) {
            requests.push(url);
            await Promise.resolve();
            if (url.endsWith('/ru.json')) {
                russianAttempts++;
                if (russianAttempts === 1) return { ok: false, status: 503 };
                return { ok: true, json: async () => ({ greeting: 'Привет' }) };
            }
            return { ok: true, json: async () => ({ greeting: 'Hello', fallback: 'English' }) };
        }
    });
    vm.runInContext(source('popup/i18n.js'), context);
    const english = await Promise.all([context.loadTranslations('en'), context.loadTranslations('en')]);
    assert.equal(requests.length, 1, 'the requested English locale and its fallback must share one fetch');
    assert.equal(english[0].greeting, 'Hello');
    assert.equal((await context.loadTranslations('ru')).greeting, 'Hello');
    const retried = await context.loadTranslations('ru');
    assert.equal(retried.greeting, 'Привет', 'a temporary locale failure must remain retryable');
    assert.equal(retried.fallback, 'English');
    assert.equal(russianAttempts, 2);
    assert.equal(requests.filter(url => url.endsWith('/en.json')).length, 1);
}

function testGuardedDialogKeepsConfirmationSynchronousAndCancelsStaleFocus() {
    const frames = [];
    const timers = new Map();
    const documentListeners = {};
    const document = {
        activeElement: null,
        addEventListener(type, handler) { documentListeners[type] = handler; }
    };
    let nextTimer = 0;
    function element() {
        const listeners = {};
        const classes = new Set(['hidden']);
        return {
            disabled: false, textContent: 'Continue',
            classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
            setAttribute() {}, removeAttribute() {},
            addEventListener(type, handler) { listeners[type] = handler; },
            dispatch(type, event = {}) { listeners[type](event); },
            focus() { if (!this.disabled) document.activeElement = this; }
        };
    }
    const context = vm.createContext({
        document,
        requestAnimationFrame: callback => frames.push(callback),
        setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: id => timers.delete(id)
    });
    for (const file of ['popup/acknowledgement-timer.js', 'popup/guarded-dialog.js']) {
        vm.runInContext(source(file), context, { filename: file });
    }
    const popup = { inert: false };
    const dialog = element();
    const cancelButton = element();
    const confirmButton = element();
    const trigger = element();
    dialog.contains = node => [dialog, cancelButton, confirmButton].includes(node);
    const controller = context.XPorterGuardedDialog.mount({
        popup, dialog, cancelButton, confirmButton, countdownStatus: element()
    });
    let confirmed = 0;
    let cancelled = 0;
    const open = seconds => controller.open({
        trigger, seconds,
        onConfirm() { confirmed++; },
        onCancel() { cancelled++; }
    });
    const flushFrames = () => { while (frames.length) frames.shift()(); };
    open(5);
    flushFrames();
    assert.equal(document.activeElement, dialog);
    assert.equal(popup.inert, true);
    assert.equal(cancelButton.disabled, true);
    confirmButton.dispatch('click');
    cancelButton.dispatch('click');
    assert.equal(confirmed, 0, 'disabled confirmation cannot run through a synthetic click');
    documentListeners.keydown({ key: 'Tab', shiftKey: true, preventDefault() {} });
    assert.equal(document.activeElement, dialog, 'focus stays on the dialog while actions are locked');
    document.activeElement = null;
    documentListeners.keydown({ key: 'Tab', preventDefault() {} });
    assert.equal(document.activeElement, dialog);
    documentListeners.keydown({ key: 'Escape', preventDefault() {} });
    assert.equal(cancelled, 0, 'Escape and Cancel cannot dismiss during the countdown');
    for (let second = 1; second <= 5; second++) {
        const [id, tick] = timers.entries().next().value;
        timers.delete(id);
        tick();
        if (second < 5) assert.equal(cancelButton.disabled, true);
    }
    assert.equal(cancelButton.disabled, false);
    assert.equal(confirmButton.disabled, false);
    documentListeners.keydown({ key: 'Escape', preventDefault() {} });
    assert.equal(cancelled, 1, 'Escape dismisses after five seconds');
    assert.equal(timers.size, 0);
    assert.equal(popup.inert, false);
    open(0);
    flushFrames();
    assert.equal(document.activeElement, cancelButton, 'stale close must not focus behind a reopened dialog');
    confirmButton.dispatch('click');
    assert.equal(confirmed, 1, 'confirmation must finish in the click stack, before any await');
    flushFrames();
    assert.equal(document.activeElement, trigger);
}

function testHelpWithoutPopoverKeepsTabsUsable() {
    const element = () => {
        const classes = new Set();
        const attributes = new Map();
        return {
            events: {}, dataset: {},
            classList: {
                add: name => classes.add(name), remove: name => classes.delete(name),
                contains: name => classes.has(name),
                toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
            },
            setAttribute: (name, value) => attributes.set(name, value),
            getAttribute: name => attributes.get(name),
            addEventListener(type, handler) { this.events[type] = handler; }
        };
    };
    const home = element(), settings = element(), trigger = element(), tooltip = element();
    home.dataset.tab = 'home'; settings.dataset.tab = 'settings';
    trigger.setAttribute('aria-label', 'Localized help without markup');
    tooltip.textContent = 'Localized help without markup';
    // Chrome 111 rejects the selector and has neither Popover method.
    tooltip.matches = () => { throw new SyntaxError('Unsupported :popover-open'); };
    trigger.querySelector = () => tooltip;
    const contents = { 'tab-home': element(), 'tab-settings': element() };
    const document = {
        querySelectorAll(selector) {
            return selector === '.tab' ? [home, settings]
                : selector === '.tab-content' ? Object.values(contents)
                : selector === '[data-i18n-tooltip]' ? [trigger] : [];
        },
        querySelector: () => home,
        getElementById: id => contents[id],
        addEventListener() {}
    };
    const context = vm.createContext({ document, window: { addEventListener() {} }, clearTimeout, setTimeout });
    vm.runInContext(source('popup/presentation.js'), context);
    context.XPorterPopupUI.mount({ popup: element(), t: value => value });
    trigger.events.pointerenter();
    assert.equal(trigger.getAttribute('title'), 'Localized help without markup');
    assert.equal(trigger.classList.contains('help-open'), false, 'native help must not expose an unpositioned overlay');
    settings.events.click();
    assert.equal(contents['tab-settings'].classList.contains('active'), true);
    trigger.events.focus();
    trigger.events.keydown({ key: 'Escape', preventDefault() {} });
    home.events.click();
    assert.equal(contents['tab-home'].classList.contains('active'), true);
    trigger.setAttribute('aria-label', 'Updated translation');
    trigger.events.pointerenter();
    assert.equal(trigger.getAttribute('title'), 'Updated translation', 'fallback follows language changes');
}

function testHelpCoordinatesMatchLegacyAndStandardZoom() {
    for (const legacy of [false, true]) for (const zoom of [0.85, 1, 1.15, 1.3]) {
        const element = () => ({
            events: {}, dataset: {}, setAttribute() {},
            classList: { add() {}, remove() {}, toggle() {} },
            addEventListener(type, handler) { this.events[type] = handler; }
        });
        const home = element(), content = element(), popup = element(), trigger = element();
        home.dataset.tab = 'home';
        const properties = {};
        let open = false;
        const tooltip = {
            scrollHeight: 200,
            style: { setProperty(key, value) { properties[key] = parseFloat(value); } },
            setAttribute() {}, matches: () => open,
            showPopover() { open = true; }, hidePopover() { open = false; }
        };
        trigger.querySelector = () => tooltip;
        trigger.offsetWidth = 16;
        // Both models represent the same painted trigger near the bottom.
        const divisor = legacy ? zoom : 1;
        trigger.getBoundingClientRect = () => ({
            left: 200 / divisor, top: 450 / divisor,
            bottom: (450 + 16 * zoom) / divisor, width: 16 * zoom / divisor
        });
        const document = {
            querySelectorAll(selector) {
                return selector === '.tab' ? [home] : selector === '.tab-content' ? [content]
                    : selector === '[data-i18n-tooltip]' ? [trigger] : [];
            },
            querySelector: selector => selector === '.tab.active' ? home : null,
            getElementById: () => content, addEventListener() {}
        };
        const width = 350 * zoom;
        const context = vm.createContext({
            document, window: { addEventListener() {} }, innerWidth: width, innerHeight: 600,
            clearTimeout, setTimeout,
            getComputedStyle: el => el === popup ? { zoom: String(zoom) }
                : { borderTopWidth: '1', borderBottomWidth: '1' }
        });
        vm.runInContext(source('popup/presentation.js'), context);
        context.XPorterPopupUI.mount({ popup, t: key => key });
        trigger.events.pointerenter();
        assert.equal(open, true);
        const near = (actual, expected) => assert(Math.abs(actual - expected) < 0.01,
            `${legacy ? 'legacy' : 'standard'}/${zoom}: ${actual} != ${expected}`);
        near(properties['--help-pop-left'] * zoom, 16);
        near(properties['--help-pop-width'] * zoom, width - 32);
        near(properties['--help-pop-safe-top'] * zoom + 202 * zoom, 442);
    }
}

const tests = [
    { name: "help coordinates match legacy and standard zoom", run: testHelpCoordinatesMatchLegacyAndStandardZoom, order: 106 },
    { name: "help without Popover keeps tabs usable", run: testHelpWithoutPopoverKeepsTabsUsable, order: 101 },
    { name: "theme restore", run: testThemeInitializationCanRevertToDark, order: 70 },
    { name: "signed-in account navigation detection", run: testContentScriptDetectsSignedInAccountFromXNavigation, order: 71 },
    { name: "acknowledgement countdown", run: testAcknowledgementCountdownRequiresFiveFullTicks, order: 72 },
    { name: "live target and viewer account context", run: testContentScriptReturnsLiveTargetAndViewerAccounts, order: 77 },
    { name: "guarded dialog lifecycle and synchronous confirmation", run: testGuardedDialogKeepsConfirmationSynchronousAndCancelsStaleFocus, order: 99 },
    { name: "locale single-flight and failure recovery", run: testLocaleLoadsShareRequestsAndRetryFailures, order: 100 }
];

module.exports = {
    id: "ui-content",
    tests
};
