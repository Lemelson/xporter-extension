#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(ROOT, file));

function localRef(baseFile, ref) {
    if (!ref || /^(?:[a-z]+:|#|\/\/)/i.test(ref)) return null;
    return path.posix.normalize(path.posix.join(path.posix.dirname(baseFile), ref.split(/[?#]/)[0]));
}

function assertFile(file, label) {
    assert(exists(file), `${label} points to missing file: ${file}`);
}

function walk(dir) {
    const absolute = path.join(ROOT, dir);
    return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
        const child = path.posix.join(dir, entry.name);
        return entry.isDirectory() ? walk(child) : [child];
    });
}

const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, '1.4.11');
assert(Number.parseInt(manifest.minimum_chrome_version, 10) >= 110,
    'download keepalive relies on Chrome 110+ extension API calls resetting the MV3 idle timer');
assertFile(manifest.background.service_worker, 'background.service_worker');
assertFile(manifest.action.default_popup, 'action.default_popup');
for (const scripts of manifest.content_scripts) {
    for (const file of scripts.js) assertFile(file, 'content_scripts');
}
for (const iconMap of [manifest.icons, manifest.action.default_icon]) {
    for (const file of Object.values(iconMap || {})) assertFile(file, 'icon');
}

const workerSource = read(manifest.background.service_worker);
const workerImports = [...workerSource.matchAll(/['"]((?:\.\.?\/)[^'"]+\.js)['"]/g)]
    .map((match) => localRef(manifest.background.service_worker, match[1]));
for (const file of workerImports) assertFile(file, 'importScripts');

const popupFile = manifest.action.default_popup;
const popupHtml = read(popupFile);
const popupRefs = [
    ...popupHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ...popupHtml.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi),
    ...popupHtml.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)
].map((match) => localRef(popupFile, match[1])).filter(Boolean);
for (const file of popupRefs) assertFile(file, 'popup asset');

const popupScripts = [...popupHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => match[1]);
assert.equal(popupScripts[0], 'theme-init.js', 'theme-init.js must remain the first popup script');
assert(
    popupScripts.indexOf('history.js') < popupScripts.indexOf('popup.js') &&
    popupScripts.indexOf('seen-posts.js') < popupScripts.indexOf('popup.js'),
    'popup modules must load before popup.js initializes them'
);

const htmlIds = [...popupHtml.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
assert.equal(new Set(htmlIds).size, htmlIds.length, 'popup.html contains duplicate ids');
const idSet = new Set(htmlIds);
const popupRuntime = popupScripts
    .map((script) => localRef(popupFile, script))
    .filter(Boolean)
    .map(read)
    .join('\n');
assert.match(
    read('popup/popup.js'),
    /canContinueComplete\s*=\s*status\s*===\s*['"]complete['"]\s*&&\s*itemCount\s*>\s*0/,
    'zero-item complete exports must not offer a pointless Resume loop'
);
assert.match(read('popup/theme-init.js'), /theme === ['"]light['"]/,
    'the early theme bootstrap must only opt into light when explicitly saved');
assert.match(read('utils/storage.js'), /theme:\s*['"]dark['"]/,
    'new settings must default to dark');
const referencedIds = [...popupRuntime.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)]
    .map((match) => match[1]);
for (const id of referencedIds) assert(idSet.has(id), `popup JS references missing id: ${id}`);

const cssFiles = ['popup/popup.css', 'popup/rate-prompt.css'];
const cssSource = cssFiles.map(read).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\([^)]*\)/g, '');
const cssConsumers = popupHtml + '\n' + popupRuntime + '\n' + read('utils/shared.js');
const dynamicCssClasses = new Set(['status-red', 'status-yellow', 'toast-error', 'toast-success']);
const cssClasses = new Set([...cssSource.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)]
    .map((match) => match[1]));
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const className of cssClasses) {
    if (dynamicCssClasses.has(className)) continue;
    const token = new RegExp(`(?:^|[\\s'"\x60.#])${escapeRegex(className)}(?=$|[\\s'"\x60:{.#])`);
    assert(token.test(cssConsumers), `CSS class has no HTML/JS consumer: ${className}`);
}

const localeDir = path.join(ROOT, 'popup/locales');
const localeFiles = fs.readdirSync(localeDir).filter((file) => file.endsWith('.json')).sort();
assert.equal(localeFiles.length, 14, 'expected 14 popup locales');
const english = JSON.parse(read('popup/locales/en.json'));
const englishKeys = Object.keys(english).sort();
for (const file of localeFiles) {
    const locale = JSON.parse(read(`popup/locales/${file}`));
    assert.deepEqual(Object.keys(locale).sort(), englishKeys, `${file} must match en.json keys`);
}

const i18nRefs = [...popupHtml.matchAll(/data-i18n(?:-[a-z-]+)?=["']([^"']+)["']/g)]
    .map((match) => match[1]);
for (const key of i18nRefs) assert(key in english, `popup references missing i18n key: ${key}`);

const storeLocaleDirs = fs.readdirSync(path.join(ROOT, '_locales')).sort();
assert.equal(storeLocaleDirs.length, 14, 'expected 14 Chrome metadata locales');
const storeKeys = Object.keys(JSON.parse(read('_locales/en/messages.json'))).sort();
for (const dir of storeLocaleDirs) {
    const messages = JSON.parse(read(`_locales/${dir}/messages.json`));
    assert.deepEqual(Object.keys(messages).sort(), storeKeys, `${dir}/messages.json must match English keys`);
}
for (const match of JSON.stringify(manifest).matchAll(/__MSG_([^_][A-Za-z0-9_]*)__/g)) {
    assert(storeKeys.includes(match[1]), `manifest references missing store message: ${match[1]}`);
}

const workerCases = new Set([...workerSource.matchAll(/case\s+['"]([A-Z][A-Z0-9_]*)['"]/g)]
    .map((match) => match[1]));
const senderSource = popupRuntime + '\n' + read('content/content.js');
const sentToWorker = new Set([...senderSource.matchAll(/type\s*:\s*['"]([A-Z][A-Z0-9_]*)['"]/g)]
    .map((match) => match[1]));
for (const type of sentToWorker) {
    assert(workerCases.has(type), `runtime message has no service-worker handler: ${type}`);
}

const workerEmits = new Set([...workerSource.matchAll(/type\s*:\s*['"]([A-Z][A-Z0-9_]*)['"]/g)]
    .map((match) => match[1]));
const consumerSource = read('popup/popup.js') + '\n' + read('content/content.js');
for (const type of workerEmits) {
    assert(consumerSource.includes(`'${type}'`) || consumerSource.includes(`"${type}"`),
        `service-worker message has no popup/content consumer: ${type}`);
}

const runtimeJs = ['background', 'content', 'popup', 'utils']
    .flatMap(walk)
    .filter((file) => file.endsWith('.js'));
for (const file of runtimeJs) {
    new vm.Script(read(file), { filename: file });
}

console.log(
    `Static contracts passed (${runtimeJs.length} runtime scripts, ` +
    `${localeFiles.length} popup locales, ${storeLocaleDirs.length} store locales).`
);
