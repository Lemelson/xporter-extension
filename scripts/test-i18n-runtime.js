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
