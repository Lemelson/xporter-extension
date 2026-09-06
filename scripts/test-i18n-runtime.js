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
