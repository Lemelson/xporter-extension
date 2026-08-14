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
assert.equal(manifest.version, '1.5.9');
assert(Number.parseInt(manifest.minimum_chrome_version, 10) >= 110,
    'download keepalive relies on Chrome 110+ extension API calls resetting the MV3 idle timer');

const packageScript = read('scripts/package.sh');
assert.match(packageScript, /\nset -euo pipefail\n/,
    'package.sh must abort immediately when any release check fails');
const packageWriteIndex = packageScript.indexOf('rm -f "$OUT"');
for (const requiredReleaseCheck of [
    'node scripts/test-static-contracts.js',
    'node scripts/test-extension-core.js',
    'node scripts/test-rate-limit.js',
    'node scripts/test-feed-capture.js'
]) {
    assert(
        packageScript.includes(requiredReleaseCheck),
        `package.sh must block production packaging on: ${requiredReleaseCheck}`
    );
    assert(
        packageScript.indexOf(requiredReleaseCheck) < packageWriteIndex,
        `${requiredReleaseCheck} must run before package.sh creates or replaces the ZIP`
    );
}

assertFile('.github/workflows/test-extension.yml', 'extension runtime CI workflow');
const runtimeWorkflow = read('.github/workflows/test-extension.yml');
for (const requiredCiCheck of [
    'node scripts/test-static-contracts.js',
    'node scripts/test-extension-core.js',
    'node scripts/test-rate-limit.js',
    'node scripts/test-feed-capture.js'
]) {
    assert(
        runtimeWorkflow.includes(requiredCiCheck),
        `extension runtime CI must run: ${requiredCiCheck}`
    );
}

assertFile(manifest.background.service_worker, 'background.service_worker');
assertFile(manifest.action.default_popup, 'action.default_popup');
for (const scripts of manifest.content_scripts) {
    for (const file of scripts.js) assertFile(file, 'content_scripts');
}
const mainWorldScripts = manifest.content_scripts.find(entry => entry.world === 'MAIN')?.js || [];
const isolatedScripts = manifest.content_scripts.find(entry => !entry.world)?.js || [];
assert(
    mainWorldScripts.indexOf('utils/native-request-template.js') <
        mainWorldScripts.indexOf('content/interceptor.js'),
    'the shared native-template validator must load before the MAIN-world interceptor'
);
assert(
    isolatedScripts.indexOf('utils/native-request-template.js') <
        isolatedScripts.indexOf('content/content.js'),
    'the shared native-template validator must load before the isolated relay'
);
for (const iconMap of [manifest.icons, manifest.action.default_icon]) {
    for (const file of Object.values(iconMap || {})) assertFile(file, 'icon');
}

const workerSource = read(manifest.background.service_worker);
const workerImports = [...workerSource.matchAll(/['"]((?:\.\.?\/)[^'"]+\.js)['"]/g)]
    .map((match) => localRef(manifest.background.service_worker, match[1]));
for (const file of workerImports) assertFile(file, 'importScripts');
assert(
    workerImports.indexOf('utils/native-request-template.js') < workerImports.indexOf('utils/api.js'),
    'the native-template validator must load before the API'
);
assert(
    workerImports.indexOf('utils/transaction-id.js') < workerImports.indexOf('utils/api.js'),
    'the transaction generator must load before the API'
);
assertFile('docs/vendor/x-client-transaction-id.LICENSE', 'transaction generator attribution');
assertFile('THIRD_PARTY_NOTICES', 'shipped third-party attribution');

const popupFile = manifest.action.default_popup;
const popupHtml = read(popupFile);
const quantitySelectHtml = /<select id="quantityLimit"[^>]*>([\s\S]*?)<\/select>/
    .exec(popupHtml)?.[1] || '';
const quantityPresetValues = [...quantitySelectHtml.matchAll(/<option value="([^"]+)"/g)]
    .map((match) => match[1]);
assert.deepEqual(
    quantityPresetValues,
    ['0', '100', '500', '1000', 'custom'],
    'quantity presets must avoid promising 5,000/10,000 Posts that X timelines do not expose'
);
assert.match(
    quantitySelectHtml,
    /Unlimited \(Posts: ≈3,200\)/,
    'the static Unlimited label must disclose approximate Posts availability without overflowing the select'
);
assert.match(
    popupHtml,
    /<option value=["']bookmarks["'][^>]*data-i18n=["']modeBookmarks["'][^>]*>[^<]*Bookmarks/,
    'the popup must expose Bookmarks without an obsolete Beta label'
);
assert.doesNotMatch(
    popupHtml,
    /bookmarksBetaDialog/,
    'the retired Bookmarks Beta acknowledgement must not block the stable mode'
);
assert.match(
    popupHtml,
    /<option value=["']txt["'][^>]*data-i18n=["']formatTxt["'][^>]*>TXT<\/option>/,
    'the post-row text format must use the concise TXT label'
);
const exportModeHtml = /<select id=["']exportMode["'][^>]*>([\s\S]*?)<\/select>/
    .exec(popupHtml)?.[1] || '';
const exportModeValues = [...exportModeHtml.matchAll(/<option value=["']([^"']+)["']/g)]
    .map((match) => match[1]);
assert.equal(exportModeValues.at(-1), 'bookmarks',
    'the less common personal Bookmarks mode must stay at the bottom of the mode list');
for (const id of [
    'bookmarksAccountCard',
    'bookmarksAccountName',
    'bookmarksAccountHandle',
    'settingsBookmarksOnly',
    'includeBookmarkReplyContext',
    'includeBookmarkArticles',
    'embedPostPhotos',
    'embedBookmarkPhotos',
    'aboutRiskCountdownStatus'
]) {
    assert.match(popupHtml, new RegExp(`id=["']${id}["']`),
        `the popup must expose ${id}`);
}
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
    popupScripts.indexOf('seen-posts.js') < popupScripts.indexOf('popup.js') &&
    popupScripts.indexOf('acknowledgement-timer.js') < popupScripts.indexOf('popup.js'),
    'popup modules must load before popup.js initializes them'
);
const updateEntries = [...popupHtml.matchAll(
    /<div class="detail-item update-item">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g
)].map((match) => match[1]);
assert.equal(updateEntries.length, 3, 'About must show the current build and two latest public releases');
assert.match(
    updateEntries[0],
    new RegExp(`<span class="update-meta-version">v${manifest.version.replace(/\./g, '\\.')}</span>`),
    'the first About update must describe the manifest build'
);
assert.match(updateEntries[0], /data-i18n=["']updateBuilt["']/,
    'an unpublished current build must be labelled Build');
assert.match(updateEntries[1], /data-i18n=["']updateReleased["']/,
    'the previous public version must be labelled Released');
assert.match(
    updateEntries[1],
    /<span class="update-meta-version">v1\.5\.8<\/span>/,
    'the previous public release must be v1.5.8'
);
const currentBuildDate = /<time data-release-date datetime="([^"]+)"/.exec(updateEntries[0])?.[1];
const footerBuildDate = /footer-build-date">([^<]+)</.exec(popupHtml)?.[1];
assert.equal(
    footerBuildDate,
    new Date(`${currentBuildDate}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
    }),
    'the footer date must match the current About build date'
);

const feedbackFile = 'docs/feedback.html';
const feedbackHtml = read(feedbackFile);
const feedbackScripts = [...feedbackHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => localRef(feedbackFile, match[1])).filter(Boolean);
for (const file of feedbackScripts) assertFile(file, 'feedback asset');
assertFile('docs/vendor/canvas-confetti.LICENSE', 'canvas-confetti attribution');
assert(feedbackScripts.includes('docs/vendor/canvas-confetti.browser.js'),
    'feedback success state must load the vendored canvas-confetti build');
assert.match(feedbackHtml, /window\.confetti\.create\(confettiCanvas,\s*\{\s*resize:\s*true,\s*useWorker:\s*true\s*\}\)/,
    'feedback confetti must use one reusable, responsive canvas instance');
assert.match(feedbackHtml, /origin:\s*\{\s*x:\s*\.018,\s*y:\s*\.72\s*\}/,
    'the left confetti cannon must stay fixed at the viewport edge');
assert.match(feedbackHtml, /origin:\s*\{\s*x:\s*\.982,\s*y:\s*\.72\s*\}/,
    'the right confetti cannon must stay fixed at the viewport edge');
assert(!feedbackHtml.includes('data-confetti-renderer='),
    'temporary confetti renderer controls must not ship');
assert(!feedbackHtml.includes('webglConfettiLayer'),
    'the rejected WebGL prototype canvas must not ship');
assert(!feedbackHtml.includes('createWebGLConfettiRenderer'),
    'the rejected WebGL prototype code must not ship');
assert.match(feedbackHtml, /fireConfettiProfiles\(mobile\s*\?\s*196\s*:\s*264,\s*layeredConfettiProfiles,\s*confettiSides\)/,
    'the selected full-density Layered Canvas treatment must remain the only recipe');
assert.match(feedbackHtml, /function\s+fireConfettiProfiles\s*\(/,
    'the Layered confetti treatment must use the shared profile renderer');
assert(!feedbackHtml.includes('confetti-piece'),
    'the obsolete DOM-particle implementation must not return');
assert.match(feedbackHtml, /\.subreason\[aria-pressed="true"\]\s+\.subreason-icon\s*\{\s*filter:\s*none;\s*transform:\s*scale\(1\.08\);/,
    'selected subreason icons must scale without adding a transient filter glow');
assert(!feedbackHtml.includes('.subreason[aria-pressed="true"] .subreason-icon::after'),
    'selected subreason icons must not restore the removed radial glow layer');
assert.match(feedbackHtml, /const FORWARDED_STAT_KEYS = Object\.freeze\(\[/,
    'feedback forwarding must use an explicit anonymous-stat allowlist');
assert.doesNotMatch(feedbackHtml, /Object\.assign\(\{\},\s*params\)/,
    'feedback must not forward arbitrary query parameters');
assert.match(feedbackHtml, /source:\s*safeSource/,
    'feedback source must be normalized instead of forwarding arbitrary text');

for (const file of feedbackScripts) {
    if (file.endsWith('.js')) new vm.Script(read(file), { filename: file });
}
for (const match of feedbackHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    new vm.Script(match[1], { filename: `${feedbackFile}:inline` });
}

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
    /canContinueComplete\s*=\s*status\s*===\s*['"]complete['"]\s*&&\s*itemCount\s*>\s*0\s*&&\s*state\.completionReason\s*!==\s*['"]source_exhausted['"]/,
    'zero-item and source-exhausted exports must not offer a pointless Resume loop'
);
assert.match(read('popup/theme-init.js'), /theme === ['"]light['"]/,
    'the early theme bootstrap must only opt into light when explicitly saved');
assert.match(read('utils/storage.js'), /theme:\s*['"]dark['"]/,
    'new settings must default to dark');
assert.match(read('utils/storage.js'), /includeReplies:\s*false/,
    'new users must start on the stable Posts endpoint');
assert.doesNotMatch(
    popupHtml,
    /id=["']includeReplies["'][^>]*\bchecked\b/,
    'the Replies checkbox must be opt-in in the static popup'
);
assert.match(
    read('popup/popup.js'),
    /includeReplies\.checked\s*=\s*currentSettings\.includeReplies\s*===\s*true/,
    'missing saved settings must not silently opt users into Replies'
);
assert.match(
    workerSource,
    /includeReplies:\s*false/,
    'fresh installs must persist the stable Posts-only default'
);
assert.match(popupHtml, /id=["']includeAboutAccountDetails["']/,
    'Settings must expose the detailed About this Account opt-in');
assert.doesNotMatch(
    popupHtml,
    /id=["']includeAboutAccountDetails["'][^>]*\bchecked\b/,
    'per-user About this Account enrichment must be off by default'
);
assert.match(
    read('utils/storage.js'),
    /includeAboutAccountDetails:\s*false/,
    'missing settings must preserve the fast 15-field user-list export'
);
assert.match(
    workerSource,
    /includeAboutAccountDetails:\s*false/,
    'fresh installs must persist the safe detailed-export default'
);
assert.match(
    read('popup/popup.js'),
    /includeAboutAccountDetails\.checked\s*=\s*[\s\S]*currentSettings\.includeAboutAccountDetails\s*===\s*true/,
    'the popup must opt into per-user About requests only after an explicit saved choice'
);
assert.match(popupHtml, /class=["'][^"']*\bhidden\b[^"']*["'][^>]*id=["']aboutAccountOptions["']/,
    'the About dependent controls must remain hidden until detailed enrichment is enabled');
assert.match(popupHtml, /id=["']aboutAccountSpeed["']/,
    'the popup must expose a separate About request concurrency preset');
assert.match(popupHtml, /id=["']aboutAccountCustomBatchSize["'][^>]*\bmin=["']1["'][^>]*\bmax=["']50["']/,
    'Custom About concurrency must be bounded between 1 and 50 accounts per batch');
assert.match(
    popupHtml,
    /class=["'][^"']*\babout-settings-group\b[^"']*["']/,
    'the About toggle and its dependent controls must read as one visual group'
);
assert.match(
    popupHtml,
    /class=["'][^"']*\bhidden\b[^"']*["'][^>]*id=["']aboutAccountOptions["']/,
    'dependent About controls must remain hidden until detailed enrichment is enabled'
);
assert.match(
    popupHtml,
    /id=["']aboutAccountMaxRetries["'][^>]*\bmin=["']1["'][^>]*\bmax=["']1440["']/,
    'About rate-limit retries must be configurable from one minute up to one day'
);
assert.match(
    read('popup/popup.js'),
    /aboutAccountOptions\.classList\.toggle\(\s*['"]hidden['"],\s*!includeAboutAccountDetails\.checked\s*\)/,
    'the About dependent settings must track the detailed-enrichment toggle'
);
assert.match(
    read('utils/storage.js'),
    /aboutAccountSpeed:\s*['"]standard['"]/,
    'missing settings must use Standard About concurrency'
);
assert.match(
    workerSource,
    /aboutAccountSpeed:\s*['"]standard['"]/,
    'fresh installs must persist Standard About concurrency'
);
assert.match(
    read('utils/storage.js'),
    /aboutAccountMaxRetries:\s*C\.ABOUT_ACCOUNT_RETRY_RANGE\?\.\[2\]\s*\?\?\s*5/,
    'missing settings must default to five one-minute About retries'
);
assert.match(
    workerSource,
    /aboutAccountMaxRetries:\s*5/,
    'fresh installs must persist five one-minute About retries'
);
assert.match(
    read('popup/popup.js'),
    /aboutAccountMaxRetries:\s*clampToInput\(aboutAccountMaxRetries,\s*5\)/,
    'the popup must persist the bounded About retry setting'
);
assert.match(
    popupHtml,
    /id=["']aboutRiskDialog["'][^>]*\brole=["']dialog["'][^>]*\baria-modal=["']true["']/,
    'consequential About settings must use an accessible confirmation dialog'
);
assert.match(popupHtml, /id=["']aboutRiskCancel["']/,
    'the About risk dialog must offer a safe cancel action');
assert.match(popupHtml, /id=["']aboutRiskConfirm["']/,
    'the About risk dialog must require an explicit consequence-labelled confirmation');
assert.match(
    read('popup/popup.js'),
    /ABOUT_RETRY_WARNING_THRESHOLD\s*=\s*60/,
    'more than one hour of About retries must require explicit confirmation'
);
assert.match(
    read('popup/popup.js'),
    /popup\.inert\s*=\s*true/,
    'opening the About risk dialog must make background controls inert'
);
assert.match(
    read('utils/storage.js'),
    /userExportSpeed:\s*['"]standard['"]/,
    'user-list exports must have an independent Standard speed default'
);
assert.match(
    workerSource,
    /userExportSpeed:\s*['"]standard['"]/,
    'fresh installs must persist the independent user-list speed default'
);
assert.match(popupHtml, /id=["']exportSpeed["']/, 'popup must expose the posts speed control');
assert.match(popupHtml, /id=["']userExportSpeed["']/, 'popup must expose the user-list speed control');
assert.match(
    read('popup/popup.js'),
    /if\s*\(resumeAddsItems\)\s*message\.extraItems\s*=\s*extraPosts/,
    'only a completed export may turn Resume into a +N quantity extension'
);
assert.match(
    read('popup/popup.js'),
    /updateUI\(\{\s*\.\.\.lastExportState,\s*running:\s*false,\s*status:\s*['"]stopped['"]/,
    'Stop must preserve partialReason and other export metadata in local popup state'
);
assert.match(
    read('popup/popup.js'),
    /partialReason:\s*result\.partialReason\s*\?\?\s*lastExportState\.partialReason\s*\?\?\s*null/,
    'ordinary Resume must preserve the Posts-only partial marker'
);
assert.match(
    read('popup/history.js'),
    /entry\.partialReason\s*===\s*['"]replies_unavailable['"]/,
    'history must visibly distinguish Posts-only fallback exports'
);
assert.match(
    read('popup/popup.js'),
    /status\s*===\s*['"]error['"]/,
    'terminal errors must participate in Start-button visibility rules'
);
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
    for (const key of [
        'modeBookmarks',
        'bookmarksAccount',
        'bookmarksCurrentAccount',
        'yourAccount',
        'signedInXAccount',
        'postsSettingsHeading',
        'bookmarksSettingsHeading',
        'acknowledgementCountdown',
        'formatTxt',
        'includeBookmarkReplyContext',
        'includeBookmarkReplyContextHelp',
        'includeBookmarkArticles',
        'includeBookmarkArticlesHelp',
        'embedPostPhotos',
        'embedBookmarkPhotos',
        'embedPhotosHelp',
        'errRepliesUnavailable',
        'repliesUnavailableBody',
        'continuePostsOnly',
        'retryReplies',
        'postsOnlyFallbackActive',
        'postsOnlyFallbackComplete',
        'postsOnlyHistory',
        'sourceExhausted'
    ]) {
        assert.equal(typeof locale[key], 'string', `${file} must define ${key}`);
        assert(locale[key].trim().length > 0, `${file} must not leave ${key} empty`);
    }
    assert.match(locale.unlimited, /3,?200/,
        `${file} Unlimited label must disclose the approximate Posts availability`);
    assert.match(
        locale.quantityLimitHelp,
        /3,?200/,
        `${file} quantity help must explain X's approximate Posts availability`
    );
    assert.match(locale.quantityLimitHelp, /X/,
        `${file} quantity help must attribute Posts availability to X`);
    assert.doesNotMatch(locale.modeBookmarks, /Beta/i,
        `${file} must not label the stable Bookmarks mode as Beta`);
    assert.doesNotMatch(locale.exportModeHelp, /Beta/i,
        `${file} export-mode help must not describe Bookmarks as Beta`);
    assert.equal(locale.formatTxt, 'TXT',
        `${file} must use the concise TXT format label`);
    assert.match(locale.aboutDesc, /TXT/,
        `${file} About summary must advertise TXT without limiting it to Posts`);
    assert.match(locale.detailFormatsBody, /TXT/,
        `${file} format details must include TXT`);
}
assert.doesNotMatch(english.aboutDesc, /posts-only/i,
    'English About summary must not call TXT posts-only');
assert.doesNotMatch(english.detailFormatsBody, /posts-only/i,
    'English format details must not call TXT posts-only');

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
