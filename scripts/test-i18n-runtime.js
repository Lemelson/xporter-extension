#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const context = vm.createContext({ Intl, console, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(path.join(root, 'utils/shared.js'), 'utf8'), context);
const languages = fs.readdirSync(path.join(root, 'popup/locales')).filter(file => file.endsWith('.json'))
    .map(file => file.slice(0, -5));
const locales = Object.fromEntries(languages.map(language => [language,
    JSON.parse(fs.readFileSync(path.join(root, `popup/locales/${language}.json`), 'utf8'))]));

test('all locale templates keep the English interpolation variables', () => {
    const variables = text => [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map(match => match[1]).sort();
    for (const [language, translations] of Object.entries(locales)) {
        assert.deepEqual(Object.keys(translations).sort(), Object.keys(locales.en).sort(), language);
        for (const key of Object.keys(locales.en)) {
            assert.deepEqual(variables(translations[key]), variables(locales.en[key]), `${language}/${key}`);
        }
    }
});

test('cookie read failures stay unknown instead of claiming the user logged out', async () => {
    for (const [cookie, error, expected] of [[null, null, false], [{ value: 'private' }, null, true],
        [null, { message: 'read unavailable' }, null]]) {
        const auth = vm.createContext({ chrome: {
            runtime: { lastError: error },
            cookies: { get(_options, callback) { callback(cookie); } }
        } });
        vm.runInContext(fs.readFileSync(path.join(root, 'utils/shared.js'), 'utf8'), auth);
        assert.equal(await auth.checkAuth(), expected);
    }
    const auth = vm.createContext({ chrome: {
        runtime: {}, cookies: { get() { throw new Error('API unavailable'); } }
    } });
    vm.runInContext(fs.readFileSync(path.join(root, 'utils/shared.js'), 'utf8'), auth);
    assert.equal(await auth.checkAuth(), null);
});

test('extension connection and resume errors use the selected language', () => {
    const keys = {
        TIMEOUT: 'errExtensionTimeout',
        MESSAGING_ERROR: 'errExtensionConnection',
        NO_EXPORT_TO_RESUME: 'errNoResume',
        'No export to resume': 'errNoResume'
    };
    for (const [language, translations] of Object.entries(locales)) {
        for (const [code, key] of Object.entries(keys)) {
            assert.equal(context.formatError(code, key => translations[key] || key), translations[key],
                `${language}: ${code} must not leak an internal code or English fallback`);
        }
    }
});

test('account counts use a complete localized template at plural boundaries', () => {
    for (const [language, translations] of Object.entries(locales)) {
        for (const mode of ['followers', 'following', 'verified_followers']) {
            for (const count of [0, 1, 2, 5, 21, 22, 25, 1000000]) {
                assert.equal(context.formatCollectedCount(count, mode, language, translations),
                    translations.accountsCollected.replace('{count}', new Intl.NumberFormat(language).format(count)));
            }
        }
    }
    assert.equal(context.formatCollectedCount(1, 'posts', 'ru', locales.ru), '1 пост собран');
    assert.equal(context.formatCollectedCount(2, 'bookmarks', 'ru', locales.ru), '2 поста собрано');
});

test('the approximate feed limit is shown only for posts without date filtering', () => {
    for (const translations of Object.values(locales)) {
        const options = ['0', '100', '500', '1000', 'custom'].map(value => ({ value }));
        const select = { querySelectorAll: () => options };
        for (const showPostAvailability of [true, false]) {
            context.localizeQuantityOptions(select, 'en', translations, showPostAvailability);
            assert.equal(options[0].textContent,
                showPostAvailability ? translations.unlimited : translations.noCustomLimit);
            assert.equal(options[1].textContent, '100', 'numeric presets must not call accounts posts');
            assert.equal(options[3].textContent, '1,000');
            assert.equal(options[4].textContent, translations.custom);
        }
    }
});

test('an intentionally empty translation stays empty instead of showing its key', () => {
    assert.equal(context.translateKey({ suffix: '' }, 'suffix'), '');
    assert.equal(context.translateKey({ title: 'Title' }, 'title'), 'Title');
    assert.equal(context.translateKey({}, 'missingKey'), 'missingKey');
    assert.equal(context.translateKey({}, 'constructor'), 'constructor',
        'inherited object properties are not translations');
    const popupSource = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
    assert.match(popupSource, /function t\(key\)\s*\{\s*return translateKey\(currentTranslations, key\);/,
        'popup t() must keep empty strings and fall back only for missing keys');
    const ratePromptSource = fs.readFileSync(path.join(root, 'popup/rate-prompt.js'), 'utf8');
    assert.doesNotMatch(ratePromptSource, /translations\[key\]\)\s*\|\|/,
        'the review prompt must not treat an empty locale string as missing');
});

test('status sentences are complete localized templates, not fixed-order fragments', () => {
    const templates = {
        authRequired: ['link'], authRequiredRetry: ['link'], lookingUpSubject: ['subject'],
        exportingSubject: ['subject'], fetchingBatch: ['batch'], batchNumber: ['batch'],
        retryingAttempt: ['attempt'], languageButtonLabel: ['language']
    };
    for (const [language, translations] of Object.entries(locales)) {
        for (const fragment of ['authWarning', 'authSuffix', 'thenTryAgain', 'lookingUp',
            'retrying', 'attempt', 'fetching', 'batch']) {
            assert.equal(fragment in translations, false, `${language}: ${fragment} fragment must be gone`);
        }
        for (const [key, names] of Object.entries(templates)) {
            const parts = context.splitTemplate(translations[key]);
            assert.deepEqual([...parts].filter(part => part.name).map(part => part.name), names, `${language}/${key}`);
            const values = Object.fromEntries(names.map(name => [name, `<${name}>`]));
            const text = context.formatTemplate(translations[key], values);
            assert.doesNotMatch(text, /\{[A-Za-z]+\}/, `${language}/${key} leaves a placeholder`);
            for (const name of names) assert(text.includes(`<${name}>`), `${language}/${key} drops ${name}`);
        }
        for (const [key, value] of Object.entries(translations)) {
            assert(value.trim().length > 0, `${language}/${key} must not be empty`);
        }
    }
    const statusSource = fs.readFileSync(path.join(root, 'popup/export-status.js'), 'utf8');
    assert.doesNotMatch(statusSource, /t\('(?:authWarning|authSuffix|thenTryAgain|lookingUp|retrying|attempt|fetching|batch)'\)/,
        'status rendering must not concatenate removed sentence fragments');
});

test('templates render DOM slots as nodes and values as text', () => {
    const created = [];
    const document = { createTextNode: text => { const node = { nodeType: 3, text }; created.push(node); return node; } };
    const local = vm.createContext({ Intl, console, document });
    vm.runInContext(fs.readFileSync(path.join(root, 'utils/shared.js'), 'utf8'), local);
    const link = { nodeType: 1, tag: 'a' };
    let children = null;
    const element = { replaceChildren: (...nodes) => { children = nodes; } };
    local.renderTemplateInto(element, locales.ja.authRequiredRetry, { link });
    assert.equal(children.filter(node => node === link).length, 1, 'the link node is inserted once');
    assert.equal(children.map(node => node === link ? locales.ja.authLink : node.text).join(''),
        'まずXにログインしてから、もう一度お試しください。');
    local.renderTemplateInto(element, 'A {value}', { value: '<b>x</b>' });
    assert.deepEqual(children.map(node => node.text), ['A ', '<b>x</b>'], 'values are text nodes, never markup');
});

test('settings persistence is refused after a failed settings load', async () => {
    const sent = [];
    const local = vm.createContext({
        Intl, console, setTimeout, clearTimeout,
        chrome: { runtime: { sendMessage(message, reply) { sent.push(message); reply({ success: true }); } } }
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'utils/shared.js'), 'utf8'), local);
    const unavailable = local.markSettingsUnavailable({});
    const refused = await local.persistSettingsPatch(unavailable, { language: 'de' });
    assert.equal(refused.error, 'SETTINGS_UNAVAILABLE');
    assert.equal(sent.length, 0, 'no SAVE_SETTINGS may leave the popup');
    assert.deepEqual(Object.keys(unavailable), [], 'the display cache must stay unchanged');
    const loaded = {};
    assert.equal((await local.persistSettingsPatch(loaded, { language: 'de' })).success, true);
    assert.equal(loaded.language, 'de');
    for (const [language, translations] of Object.entries(locales)) {
        for (const [code, key] of [['SETTINGS_UNAVAILABLE', 'errSettingsUnavailable'],
            ['STORAGE_READ_FAILED', 'errStorageReadFailed']]) {
            assert.equal(local.formatError(code, k => local.translateKey(translations, k)), translations[key],
                `${language}: ${code}`);
        }
    }
});

test('debounced saves can be flushed or cancelled', async () => {
    let calls = 0;
    const saved = context.debounce(() => { calls += 1; return { success: true }; }, 20);
    saved();
    saved.cancel();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls, 0, 'cancel drops the pending save');
    saved();
    assert.deepEqual(saved.flush(), { success: true });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls, 1, 'flush runs once and clears the timer');
});

test('temporary X failures and storage read failures have localized guidance', () => {
    for (const [language, translations] of Object.entries(locales)) {
        const t = key => context.translateKey(translations, key);
        for (const code of ['GRAPHQL_TRANSIENT', 'API_SERVER_ERROR', 'API_ERROR_500', 'API_ERROR_503',
            'INVALID_JSON_RESPONSE']) {
            assert.equal(context.formatError(code, t), translations.errXTemporary, `${language}: ${code}`);
        }
        assert.equal(context.formatError('STORAGE_READ_FAILED', t), translations.errStorageReadFailed);
    }
    assert.equal(context.formatError('API_ERROR_404', key => key), 'API_ERROR_404',
        'only server-side statuses are described as temporary');
    assert.match(context.formatError('API_ERROR_502'), /temporary/, 'English fallback without a translator');
});

test('rapid language choices finish in selection order even when an earlier locale is slow', async () => {
    const source = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
    const functionStart = source.indexOf('    async function selectLanguage(');
    const queueStart = source.indexOf('    let pendingLanguageChange =');
    const start = queueStart >= 0 ? queueStart : functionStart;
    const selection = source.slice(start, source.indexOf('\n    function langOptions(', start));
    const rendered = [];
    const persisted = [];
    let releaseRussian;
    const russianGate = new Promise(resolve => { releaseRussian = resolve; });
    const sandbox = vm.createContext({
        currentLang: 'en', currentSettings: {}, document: { activeElement: {} },
        langDropdown: { contains: () => false }, closeLangDropdown() {}, window: {},
        async renderLanguage(code) {
            if (code === 'ru') await russianGate;
            rendered.push(code);
        },
        async persistSettingsPatch(settings, patch) {
            persisted.push(patch.language);
            settings.language = patch.language;
            return { success: true };
        }, showToast() {}, formatError() {}, t() {}
    });
    vm.runInContext(selection, sandbox);
    const first = sandbox.selectLanguage('ru');
    const second = sandbox.selectLanguage('de');
    await new Promise(resolve => setImmediate(resolve));
    releaseRussian();
    await Promise.all([first, second]);
    assert.deepEqual(rendered, ['ru', 'de']);
    assert.deepEqual(persisted, ['ru', 'de']);
    assert.equal(sandbox.currentLang, 'de');
    assert.equal(sandbox.currentSettings.language, 'de');
});

test('failed format save restores every format-dependent control', async () => {
    const source = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
    const listenerStart = source.indexOf("    outputFormat.addEventListener('change',");
    const revisionStart = source.indexOf('    let outputFormatRevision =');
    const start = revisionStart >= 0 ? revisionStart : listenerStart;
    const handler = source.slice(start, source.indexOf('\n    // ==================== Language Selector', start));
    let onChange;
    const layouts = [];
    const sandbox = vm.createContext({
        outputFormat: { value: 'xlsx', addEventListener(type, callback) { onChange = callback; } },
        exportMode: { value: 'posts' }, currentSettings: { outputFormat: 'csv' },
        applyModeUI() { layouts.push(sandbox.outputFormat.value); },
        async persistSettingsPatch() { return { error: 'STORAGE_FULL' }; },
        showToast() {}, formatError() {}, t() {}, lastExportState: null
    });
    vm.runInContext(handler, sandbox);
    await onChange();
    assert.equal(sandbox.outputFormat.value, 'csv');
    assert.deepEqual(layouts, ['xlsx', 'csv']);
});

test('download polling recovers a missed completion without releasing request preparation', async () => {
    const source = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
    const refreshStart = source.indexOf('    async function refreshDownloadPlan(');
    const refresh = source.slice(refreshStart, source.indexOf('\n    async function applyLanguage(', refreshStart));
    const intervalStart = source.indexOf('    setInterval(async () => {');
    const pendingStart = source.indexOf('    let downloadPollPending =');
    const pollStart = pendingStart >= 0 ? pendingStart : intervalStart;
    const poll = source.slice(pollStart, source.indexOf('\n    // ==================== Auto-fill', pollStart));
    let tick;
    let workerActive = false;
    const sandbox = vm.createContext({
        downloadPlanRequest: 0, lastExportState: { status: 'complete', running: false, tweetCount: 3 },
        lastItemCount: 3, outputFormat: { value: 'csv' }, downloadInProgress: true,
        downloadRequestPending: false, lastDownloadProgress: { partNumber: 1 }, statusAvailable: true,
        document: { visibilityState: 'visible' },
        async sendMessage() { return { count: 3, active: workerActive }; },
        renderDownloadPlan() {}, updateUI() {},
        setDownloadBusy(busy) { sandbox.downloadInProgress = busy; },
        setInterval(callback) { tick = callback; }
    });
    vm.runInContext(refresh + poll, sandbox);
    await tick();
    assert.equal(sandbox.downloadInProgress, false, 'missed terminal broadcast must not leave Home locked');
    sandbox.downloadInProgress = true;
    workerActive = true;
    await tick();
    assert.equal(sandbox.downloadInProgress, true, 'active worker download must retain its lock');
    workerActive = false;
    sandbox.downloadRequestPending = true;
    await tick();
    assert.equal(sandbox.downloadInProgress, true, 'initial request must retain its lock');
});

test('an older rejected format save cannot revert a newer successful choice', async () => {
    const source = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
    const listenerStart = source.indexOf("    outputFormat.addEventListener('change',");
    const revisionStart = source.indexOf('    let outputFormatRevision =');
    const start = revisionStart >= 0 ? revisionStart : listenerStart;
    const handler = source.slice(start, source.indexOf('\n    // ==================== Language Selector', start));
    let onChange;
    let rejectFirst;
    const sandbox = vm.createContext({
        outputFormat: { value: 'xlsx', addEventListener(type, callback) { onChange = callback; } },
        exportMode: { value: 'posts' }, currentSettings: { outputFormat: 'csv' },
        applyModeUI() {},
        persistSettingsPatch(settings, patch) {
            if (patch.outputFormat === 'xlsx') return new Promise(resolve => { rejectFirst = resolve; });
            settings.outputFormat = patch.outputFormat;
            return Promise.resolve({ success: true });
        }, showToast() {}, formatError() {}, t() {}, lastExportState: null
    });
    vm.runInContext(handler, sandbox);
    const first = onChange();
    await new Promise(resolve => setImmediate(resolve));
    sandbox.outputFormat.value = 'json';
    const second = onChange();
    rejectFirst({ error: 'STORAGE_FULL' });
    await Promise.all([first, second]);
    assert.equal(sandbox.outputFormat.value, 'json');
    assert.equal(sandbox.currentSettings.outputFormat, 'json');
});

test('download recovery polling does not starve slow inactive-plan replies', async () => {
    const source = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
    const refreshStart = source.indexOf('    async function refreshDownloadPlan(');
    const refresh = source.slice(refreshStart, source.indexOf('\n    async function applyLanguage(', refreshStart));
    const intervalStart = source.indexOf('    setInterval(async () => {');
    const pendingStart = source.indexOf('    let downloadPollPending =');
    const pollStart = pendingStart >= 0 ? pendingStart : intervalStart;
    const poll = source.slice(pollStart, source.indexOf('\n    // ==================== Auto-fill', pollStart));
    let tick;
    const replies = [];
    const sandbox = vm.createContext({
        downloadPlanRequest: 0, lastExportState: { status: 'complete', running: false, tweetCount: 3 },
        lastItemCount: 3, outputFormat: { value: 'csv' }, downloadInProgress: true,
        downloadRequestPending: false, lastDownloadProgress: {}, statusAvailable: true,
        document: { visibilityState: 'visible' },
        sendMessage() { return new Promise(resolve => replies.push(resolve)); },
        renderDownloadPlan() {}, updateUI() {},
        setDownloadBusy(busy) { sandbox.downloadInProgress = busy; },
        setInterval(callback) { tick = callback; }
    });
    vm.runInContext(refresh + poll, sandbox);
    const first = tick();
    const second = tick();
    const requests = replies.length;
    replies.forEach(resolve => resolve({ active: false, count: 3 }));
    await Promise.all([first, second]);
    assert.equal(requests, 1, 'a later interval must await the outstanding recovery request');
    assert.equal(sandbox.downloadInProgress, false);
});

test('a queued language choice survives the preceding save failure', async () => {
    const source = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
    const start = source.indexOf('    let pendingLanguageChange =');
    const selection = source.slice(start, source.indexOf('\n    function langOptions(', start));
    const rendered = [];
    let failRussian;
    const sandbox = vm.createContext({
        currentLang: 'en', currentSettings: { language: 'en' }, document: { activeElement: {} },
        langDropdown: { contains: () => false }, closeLangDropdown() {}, window: {},
        async renderLanguage(code) { rendered.push(code); },
        persistSettingsPatch(settings, patch) {
            if (patch.language === 'ru') return new Promise(resolve => { failRussian = resolve; });
            settings.language = patch.language;
            return Promise.resolve({ success: true });
        }, showToast() {}, formatError() {}, t() {}
    });
    vm.runInContext(selection, sandbox);
    const first = sandbox.selectLanguage('ru');
    const second = sandbox.selectLanguage('de');
    await new Promise(resolve => setImmediate(resolve));
    failRussian({ error: 'STORAGE_FULL' });
    await Promise.all([first, second]);
    assert.deepEqual(rendered, ['ru', 'en', 'de']);
    assert.equal(sandbox.currentLang, 'de');
    assert.equal(sandbox.currentSettings.language, 'de');
});

test('delayed successful format replies preserve the confirmed cache and later rollback', async () => {
    const source = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
    const start = source.indexOf('    let outputFormatRevision =');
    const handler = source.slice(start, source.indexOf('\n    // ==================== Language Selector', start));
    let onChange;
    let releaseFirst;
    const calls = [];
    const sandbox = vm.createContext({
        outputFormat: { value: 'xlsx', addEventListener(type, callback) { onChange = callback; } },
        exportMode: { value: 'posts' }, currentSettings: { outputFormat: 'csv' },
        applyModeUI() {},
        async persistSettingsPatch(settings, patch) {
            calls.push(patch.outputFormat);
            if (patch.outputFormat === 'xlsx') await new Promise(resolve => { releaseFirst = resolve; });
            if (patch.outputFormat === 'txt') return { error: 'STORAGE_FULL' };
            // Match shared.js: cache changes before the caller gets its reply.
            Object.assign(settings, patch);
            return { success: true };
        }, showToast() {}, formatError() {}, t() {}, lastExportState: null
    });
    vm.runInContext(handler, sandbox);
    const first = onChange();
    await new Promise(resolve => setImmediate(resolve));
    sandbox.outputFormat.value = 'json';
    const second = onChange();
    await new Promise(resolve => setImmediate(resolve));
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(sandbox.currentSettings.outputFormat, 'json', 'older success must not overwrite the latest cache');
    assert.equal(sandbox.outputFormat.value, 'json');
    sandbox.outputFormat.value = 'txt';
    await onChange();
    assert.equal(sandbox.outputFormat.value, 'json', 'failed latest choice rolls back to confirmed JSON');
    assert.deepEqual(calls, ['xlsx', 'json', 'txt']);
});

test('switching from a pending TXT selection to accounts persists the normalized CSV format', async () => {
    const source = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
    const modeStart = source.indexOf('    function commitModeChange(') >= 0
        ? source.indexOf('    function commitModeChange(') : source.indexOf('    async function commitModeChange(');
    const mode = source.slice(modeStart, source.indexOf("    exportMode.addEventListener('change',", modeStart));
    const formatStart = source.indexOf('    let outputFormatRevision =');
    const format = source.slice(formatStart, source.indexOf('\n    // ==================== Language Selector', formatStart));
    let onChange;
    let releaseText;
    const persisted = { outputFormat: 'csv', exportMode: 'posts' };
    const sandbox = vm.createContext({
        committedMode: 'posts', exportMode: { value: 'posts' },
        outputFormat: { value: 'txt', addEventListener(type, callback) { onChange = callback; } },
        currentSettings: { ...persisted }, lastExportState: { status: 'idle' },
        applyModeUI(mode) { if (mode === 'followers' && sandbox.outputFormat.value === 'txt') sandbox.outputFormat.value = 'csv'; },
        async persistSettingsPatch(settings, patch) {
            Object.assign(persisted, patch);
            if (patch.outputFormat === 'txt') await new Promise(resolve => { releaseText = resolve; });
            Object.assign(settings, patch);
            return { success: true };
        }, showToast() {}, formatError() {}, t() {}, updateUI() {}
    });
    vm.runInContext(mode + format, sandbox);
    const textSave = onChange();
    await new Promise(resolve => setImmediate(resolve));
    sandbox.exportMode.value = 'followers';
    const modeSave = sandbox.commitModeChange('followers');
    await new Promise(resolve => setImmediate(resolve));
    releaseText();
    await Promise.all([textSave, modeSave]);
    assert.equal(sandbox.outputFormat.value, 'csv');
    assert.equal(sandbox.currentSettings.outputFormat, 'csv');
    assert.equal(persisted.outputFormat, 'csv');
    assert.equal(persisted.exportMode, 'followers');
});
