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

const tests = [
    { name: "theme restore", run: testThemeInitializationCanRevertToDark, order: 70 },
    { name: "signed-in account navigation detection", run: testContentScriptDetectsSignedInAccountFromXNavigation, order: 71 },
    { name: "acknowledgement countdown", run: testAcknowledgementCountdownRequiresFiveFullTicks, order: 72 },
    { name: "live target and viewer account context", run: testContentScriptReturnsLiveTargetAndViewerAccounts, order: 77 }
];

module.exports = {
    id: "ui-content",
    tests
};
