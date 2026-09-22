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
assert.match(
    manifest.version,
    /^\d+\.\d+\.\d+$/,
    'manifest version must use Chrome Web Store major.minor.patch syntax'
);
assert(Number.parseInt(manifest.minimum_chrome_version, 10) >= 110,
    'download keepalive relies on Chrome 110+ extension API calls resetting the MV3 idle timer');

const requiredDeterministicSuites = [
    'scripts/test-emoji-assets.js',
    'scripts/test-ladybug.js',
    'scripts/test-settings-telemetry.js',
    'scripts/test-diagnostics.js',
    'scripts/test-diagnostics-codec.js',
    'scripts/test-feedback-collector.js',
    'scripts/test-usage-upload.js',
    'scripts/test-static-contracts.js',
    'scripts/test-i18n-runtime.js',
    'scripts/test-extension-core.js',
    'scripts/test-rate-limit.js',
    'scripts/test-feed-capture.js',
    'scripts/test-tooling-policy.js',
    'scripts/test-storage-concurrency.js',
    'scripts/test-download-transaction.js',
    'scripts/test-bookmark-context-lifecycle.js',
    'scripts/test-export-persistence.js',
    'scripts/test-api-discovery-cancellation.js',
    'scripts/test-capture-contract.js',
    'scripts/test-export-policy.js',
    'scripts/test-worker-lifecycle.js'
];
assertFile('scripts/test-all.js', 'canonical deterministic gate');
const testAllSource = read('scripts/test-all.js');
const suiteListSource = /const SUITES\s*=\s*\[([\s\S]*?)\];/.exec(testAllSource)?.[1] || '';
const aggregatedSuites = [...suiteListSource.matchAll(/['"](scripts\/test-[^'"]+\.(?:js|mjs))['"]/g)]
    .map(match => match[1]);
assert.deepEqual(
    aggregatedSuites,
    requiredDeterministicSuites,
    'test-all.js must run every deterministic suite once, in canonical order'
);
assert.match(testAllSource, /for\s*\(\s*const\s+suite\s+of\s+SUITES\s*\)/,
    'test-all.js must execute its explicit suite list sequentially');
assert.match(testAllSource, /spawnSync\([\s\S]*?stdio:\s*['"]inherit['"]/,
    'test-all.js must inherit each suite output');
assert.match(testAllSource, /result\.status\s*!==\s*0[\s\S]*?process\.exit\(/,
    'test-all.js must fail fast with the first nonzero suite status');
for (const browserCheck of [
    'scripts/test-extension-smoke.mjs',
    'scripts/test-popup-footer-layout.mjs',
    'scripts/test-popup-tooltip-layout.mjs',
    'scripts/test-xlsx-photo-options-layout.mjs',
    'scripts/test-photo-permission-rationale.mjs'
]) {
    assertFile(browserCheck, 'documented browser check');
}

const packageScript = read('scripts/package.sh');
assert.match(packageScript, /\nset -euo pipefail\n/,
    'package.sh must abort immediately when any release check fails');
const packageWriteIndex = packageScript.indexOf('mv -f "$TEMP_OUT" "$OUT"');
assert(packageWriteIndex >= 0,
    'package.sh must replace the destination only after building and validating a temporary ZIP');
const canonicalGateCommand = 'node scripts/test-all.js';
assert(packageScript.includes(canonicalGateCommand),
    `package.sh must block production packaging on: ${canonicalGateCommand}`);
assert(packageScript.indexOf(canonicalGateCommand) < packageWriteIndex,
    `${canonicalGateCommand} must run before package.sh creates or replaces the ZIP`);
for (const suite of requiredDeterministicSuites) {
    assert.doesNotMatch(
        packageScript,
        new RegExp(`node\\s+${suite.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        `package.sh must delegate ${suite} through test-all.js`
    );
}

if (exists('.github/workflows/test-extension.yml')) {
    const runtimeWorkflow = read('.github/workflows/test-extension.yml');
    assert(runtimeWorkflow.includes(canonicalGateCommand),
        `extension runtime CI must run: ${canonicalGateCommand}`);
    for (const suite of requiredDeterministicSuites) {
        assert.doesNotMatch(
            runtimeWorkflow,
            new RegExp(`node\\s+${suite.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
            `extension runtime CI must delegate ${suite} through test-all.js`
        );
    }
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
const thirdPartyNotices = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES'), 'utf8');
assert.match(
    thirdPartyNotices,
    /Tabler Icons:[\s\S]*MIT License[\s\S]*Copyright \(c\) 2020-2026 Paweł Kuna/,
    'the shipped attribution must include the official Tabler Icons MIT notice'
);

const popupFile = manifest.action.default_popup;
const popupHtml = read(popupFile);
const quantitySelectHtml = /<select id="quantityLimit"[^>]*>([\s\S]*?)<\/select>/
    .exec(popupHtml)?.[1] || '';
const quantityPresetValues = [...quantitySelectHtml.matchAll(/<option value="([^"]+)"/g)]
    .map((match) => match[1]);
assert.deepEqual(
    quantityPresetValues,
    ['0', '100', '500', '1000', 'custom'],
    'quantity presets must match the experimental 1.5.9 runtime'
);
assert.match(
    quantitySelectHtml,
    /<option value=["']0["'][^>]*data-i18n=["']unlimited["']>[^<]*No limit[^<]*3,200[^<]*<\/option>/,
    'quantity select must show no custom limit and the approximate post count'
);
for (const id of [
    'customDelaySec',
    'postSafetyBreakMin',
    'userCustomDelaySec',
    'userSafetyBreakMin'
]) {
    assert(
        new RegExp(
            `<input(?=[^>]*id="${id}")(?=[^>]*inputmode="decimal")[^>]*>`,
            'i'
        ).test(popupHtml),
        `${id} must expose a locale-friendly decimal input`
    );
}
for (const id of [
    'postSafetyBreakEnabled',
    'postSafetyBreakRows',
    'postSafetyBreakEvery',
    'userSafetyBreakEnabled',
    'userSafetyBreakRows',
    'userSafetyBreakEvery'
]) {
    assert.match(popupHtml, new RegExp(`id=["']${id}["']`),
        `Settings must expose independent ${id}`);
}
const settingsGroups = Object.fromEntries(
    [...popupHtml.matchAll(
        /<section[^>]*data-settings-scope=["']([^"']+)["'][^>]*>([\s\S]*?)<\/section>/g
    )].map((match) => [match[1], match[2]])
);
assert.match(settingsGroups.quantity || '', /id=["']quantityLimit["']/,
    'quantity limit must be its own settings group');
assert.match(settingsGroups.posts || '', /id=["']exportSpeed["']/,
    'Posts & Bookmarks group must contain its speed');
assert.match(settingsGroups.posts || '', /id=["']postSafetyBreakEnabled["']/,
    'Posts & Bookmarks group must contain its Scheduled breaks');
assert.doesNotMatch(settingsGroups.posts || '', /id=["']userExportSpeed["']/,
    'Posts & Bookmarks group must not visually absorb User Lists controls');
assert.match(settingsGroups.users || '', /id=["']userExportSpeed["']/,
    'User Lists group must contain its speed');
assert.match(settingsGroups.users || '', /id=["']userSafetyBreakEnabled["']/,
    'User Lists group must contain its Scheduled breaks');
const popupCss = read('popup/popup.css');
const settingsGroupCss = /\.settings-control-group\s*\{([\s\S]*?)\}/
    .exec(popupCss)?.[1] || '';
assert.match(settingsGroupCss, /border-block-end:/,
    'settings scopes must use straight separators');
assert.doesNotMatch(settingsGroupCss, /border-radius|background:|box-shadow:/,
    'settings scopes must not render as rounded cards');
const safetyBreakCss = /\.safety-break-setting\s*\{([\s\S]*?)\}/
    .exec(popupCss)?.[1] || '';
assert.doesNotMatch(safetyBreakCss, /border-radius|background:|box-shadow:/,
    'Scheduled breaks must not add a nested rounded card');
for (const safetyHelp of [
    /id=["']postSafetyBreakEnabled["'][\s\S]*?class=["']date-help help-local["']/,
    /id=["']userSafetyBreakEnabled["'][\s\S]*?class=["']date-help help-local["']/
]) {
    assert.match(popupHtml, safetyHelp,
        'Scheduled-break help must open from its own icon instead of the viewport top');
}
assert.doesNotMatch(popupHtml, /id=["'](?:customCooldownMin|customBatchSize|userCustomCooldownMin|userCustomBatchSize)["']/,
    'Custom speed must control only the delay between requests');
for (const id of [
    'statusPhaseIcon',
    'statusSubtitle',
    'statusPhaseHelp'
]) {
    assert.match(popupHtml, new RegExp(`id=["']${id}["']`),
        `export status must expose ${id} for distinct wait states`);
}
assert.match(
    popupHtml,
    /<option value=["']txt["'][^>]*data-i18n=["']formatTxt["'][^>]*>TXT<\/option>/,
    'the restored post-row text format must use the 1.5.9 TXT label'
);
const exportModeHtml = /<select id=["']exportMode["'][^>]*>([\s\S]*?)<\/select>/
    .exec(popupHtml)?.[1] || '';
const exportModeValues = [...exportModeHtml.matchAll(/<option value=["']([^"']+)["']/g)]
    .map((match) => match[1]);
assert.deepEqual(
    exportModeValues,
    ['posts', 'followers', 'following', 'verified_followers', 'bookmarks'],
    'modes must include the restored viewer-owned Bookmarks export'
);
const usernameFieldHtml = /<div class=["']field["'] id=["']usernameField["']>([\s\S]*?)<\/div>\s*<\/div>/
    .exec(popupHtml)?.[0] || '';
assert.match(
    usernameFieldHtml,
    /class=["'][^"']*\baccount-card\b[^"']*["'][^>]*id=["']targetAccountCard["']/,
    'profile exports must keep the editable username inside the shared account card'
);
assert.match(
    usernameFieldHtml,
    /<img[^>]*id=["']targetAccountAvatar["'][^>]*alt=["']["']/,
    'the target account card must expose a decorative avatar'
);
assert.match(
    usernameFieldHtml,
    /<input[^>]*id=["']usernameInput["']/,
    'the target account card must preserve the native editable username input'
);
assert.match(
    usernameFieldHtml,
    /class=["'][^"']*\baccount-handle-editor\b[^"']*["'][^>]*id=["']targetAccountHandleEditor["']/,
    'the username must sit in an explicit editable inset instead of looking like static metadata'
);
assert.match(
    usernameFieldHtml,
    /class=["'][^"']*\baccount-edit-icon\b[^"']*["'][^>]*aria-hidden=["']true["'][\s\S]*?data-tabler-icon=["']pencil["']/,
    'the editable handle inset must expose a decorative official pencil cue'
);
assert.doesNotMatch(
    usernameFieldHtml,
    /data-i18n=["']yourAccount["']/,
    'profile exports must not label the target profile as the signed-in account'
);
const bookmarksAccountHtml =
    /<div class=["']field hidden["'] id=["']bookmarksAccountField["']>([\s\S]*?)<\/div>\s*<\/div>/
        .exec(popupHtml)?.[0] || '';
assert.match(
    bookmarksAccountHtml,
    /class=["'][^"']*\baccount-card\b[^"']*["'][^>]*id=["']bookmarksAccountCard["'][^>]*role=["']group["']/,
    'Bookmarks must use the same static account-card semantics without a live-region role'
);
assert.match(
    bookmarksAccountHtml,
    /class=["'][^"']*\baccount-owner-badge\b[^"']*["'][^>]*data-i18n=["']yourAccount["']/,
    'only Bookmarks must show the localized owner badge'
);
assert.doesNotMatch(popupHtml, /id=["']profileFeed["']/,
    'the ambiguous profile-feed selector must not remain in the popup');
for (const postTypeControl of [
    'includeOriginalPosts',
    'includeQuotes',
    'includeReplies',
    'includeRetweets',
    'includeArticles'
]) {
    assert.match(
        popupHtml,
        new RegExp(`id=["']${postTypeControl}["']`),
        `Home must expose an explicit ${postTypeControl} post-type choice`
    );
}
const postSelectionIndex = popupHtml.indexOf('id="postSelectionPanel"');
const outputFormatIndex = popupHtml.indexOf('id="outputFormat"');
assert(outputFormatIndex > popupHtml.indexOf('id="exportMode"') && outputFormatIndex < postSelectionIndex,
    'mode and output format must appear together before post-type choices');
assert(postSelectionIndex < popupHtml.indexOf('id="startBtn"'),
    'post-type choices must precede Start in the form');
assert(popupHtml.indexOf('id="exportStatus"') < outputFormatIndex,
    'active status must precede setup controls');
const tablerPostTypeIcons = {
    original: {
        name: 'pencil',
        paths: [
            'M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4',
            'M13.5 6.5l4 4'
        ]
    },
    quote: {
        name: 'quote',
        paths: [
            'M10 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5',
            'M19 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5'
        ]
    },
    reply: {
        name: 'message-reply',
        paths: [
            'M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12',
            'M11 8l-3 3l3 3',
            'M16 11h-8'
        ]
    },
    repost: {
        name: 'repeat',
        paths: [
            'M4 12v-3a3 3 0 0 1 3 -3h13m-3 -3l3 3l-3 3',
            'M20 12v3a3 3 0 0 1 -3 3h-13m3 3l-3 -3l3 -3'
        ]
    },
    article: {
        name: 'article',
        paths: [
            'M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12',
            'M7 8h10',
            'M7 12h10',
            'M7 16h10'
        ]
    }
};
for (const [type, tablerIcon] of Object.entries(tablerPostTypeIcons)) {
    const iconBlock = new RegExp(
        `<span[^>]*data-post-type-icon=["']${type}["'][^>]*>[\\s\\S]*?<\\/span>`
    ).exec(popupHtml)?.[0] || '';
    assert.match(
        iconBlock,
        new RegExp(`data-tabler-icon=["']${tablerIcon.name}["']`),
        `post selection must identify the official Tabler ${tablerIcon.name} icon for ${type}`
    );
    assert.match(
        iconBlock,
        /<svg\b[^>]*\bviewBox=["']0 0 24 24["'][^>]*\bstroke-width=["']2["']/,
        `post selection must expose a large inline SVG icon for ${type}`
    );
    for (const pathData of tablerIcon.paths) {
        assert(
            iconBlock.includes(`<path d="${pathData}" />`),
            `post selection ${type} must preserve the official Tabler ${tablerIcon.name} path`
        );
    }
}
for (const id of ['xlsxPhotoOptions', 'xlsxPhotoLinks', 'xlsxPhotoEmbed']) {
    assert.match(
        popupHtml,
        new RegExp(`id=["']${id}["']`),
        `XLSX photo choices must expose ${id}`
    );
}
for (const type of ['links', 'embed']) {
    assert.match(
        popupHtml,
        new RegExp(`data-xlsx-photo-icon=["']${type}["'][^>]*>[\\s\\S]*?<svg\\b`),
        `XLSX photo choice ${type} must expose a large inline SVG icon`
    );
}
assert.match(
    popupHtml,
    /Tabler Icons \(MIT\): link, photo — https:\/\/github\.com\/tabler\/tabler-icons\/tree\/main\/icons\/outline/,
    'XLSX photo icons must identify their official Tabler Icons source'
);
assert.match(
    popupHtml,
    /data-xlsx-photo-icon=["']links["'][\s\S]*?<svg[^>]*viewBox=["']0 0 24 24["'][^>]*stroke-width=["']2["'][\s\S]*?<path d=["']M9 15l6 -6["'] \/>[\s\S]*?<path d=["']M11 6l\.463 -\.536a5 5 0 0 1 7\.071 7\.072l-\.534 \.464["'] \/>[\s\S]*?<path d=["']M13 18l-\.397 \.534a5\.068 5\.068 0 0 1 -7\.127 0a4\.972 4\.972 0 0 1 0 -7\.071l\.524 -\.463["'] \/>/,
    'links mode must use the exact official Tabler Link outline paths'
);
assert.match(
    popupHtml,
    /data-xlsx-photo-icon=["']embed["'][\s\S]*?<svg[^>]*viewBox=["']0 0 24 24["'][^>]*stroke-width=["']2["'][\s\S]*?<path d=["']M15 8h\.01["'] \/>[\s\S]*?<path d=["']M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12["'] \/>[\s\S]*?<path d=["']M3 16l5 -5c\.928 -\.893 2\.072 -\.893 3 0l5 5["'] \/>[\s\S]*?<path d=["']M14 14l1 -1c\.928 -\.893 2\.072 -\.893 3 0l3 3["'] \/>/,
    'embed mode must use the exact official Tabler Photo outline paths'
);
assert.match(
    popupHtml,
    /class=["'][^"']*xlsx-photo-recommended-badge[^"']*["'][^>]*data-i18n=["']xlsxPhotoRecommended["']/,
    'the links-only XLSX choice must expose a localized Recommended badge'
);
assert.match(
    popupHtml,
    /id=["']xlsxPhotoOptions["'][^>]*\brole=["']radiogroup["']/,
    'XLSX photo choices must be one accessible mutually exclusive group'
);
assert.doesNotMatch(
    popupHtml,
    /id=["'](?:embedPostPhotos|embedBookmarkPhotos)["']/,
    'the old duplicate photo toggles must not remain in the popup'
);
assert.doesNotMatch(popupHtml, /id=["']settingsPostsOnly["']/,
    'post content choices must not remain hidden in Settings');
assert(!manifest.host_permissions.includes('https://pbs.twimg.com/*'),
    'photo host access must never be a required permission — that is what disabled every 1.5.8 installation');
assert.deepEqual(manifest.optional_host_permissions, ['https://pbs.twimg.com/*'],
    'only photo embedding requires optional, gesture-granted hosts');
assert(!manifest.host_permissions.some(host => host.includes('script.google')),
    'diagnostic sharing must not add required permissions to existing installs');

const popupRefs = [
    ...popupHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ...popupHtml.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi),
    ...popupHtml.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)
].map((match) => localRef(popupFile, match[1])).filter(Boolean);
for (const file of popupRefs) assertFile(file, 'popup asset');

const popupScripts = [...popupHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => match[1]);
assert.deepEqual(popupScripts.slice(0, 3), ['emoji-platform.js', 'theme-presets.js', 'theme-init.js'], 'emoji platform runs before paint; theme catalog precedes early theme application');
for (const script of ['history.js', 'seen-posts.js', 'guarded-dialog.js', 'export-status.js',
    'presentation.js', 'account-fields.js', 'settings-form.js']) {
    assert(popupScripts.indexOf(script) >= 0 && popupScripts.indexOf(script) < popupScripts.indexOf('popup.js'),
        `${script} must load before the popup coordinator`);
}
const updateEntries = [...popupHtml.matchAll(
    /<div class="detail-item update-item">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g
)].map((match) => match[1]);
assert.equal(updateEntries.length, 3, 'About must show the current build and two previous updates');
const readme = read('README.md');
const chromeWebStoreRelease = /Chrome Web Store listing reports version `(\d+\.\d+\.\d+)`/
    .exec(readme)?.[1];
const mainDevelopmentVersion = /current local release candidate reports version `(\d+\.\d+\.\d+)`/
    .exec(readme)?.[1];
assert.match(
    chromeWebStoreRelease || '',
    /^\d+\.\d+\.\d+$/,
    'README must identify the version released through the Chrome Web Store'
);
assert.equal(
    mainDevelopmentVersion,
    manifest.version,
    'README must identify the manifest version as the current packaged version'
);
assert.match(
    updateEntries[0],
    new RegExp(`<span class="update-meta-version">v${manifest.version.replace(/\./g, '\\.')}</span>`),
    'the first About update must describe the packaged manifest version'
);
assert.match(updateEntries[0], /<time data-release-date datetime=/,
    'release history must retain its date without requiring a Released prefix');
assert.match(updateEntries[1], /<time data-release-date datetime=/,
    'release history must retain its date without requiring a Released prefix');
assert.match(
    updateEntries[1],
    /<span class="update-meta-version">v2\.0\.1<\/span>/,
    'the previous build must be v2.0.1'
);
assert.match(updateEntries[2], /<time data-release-date datetime=/,
    'release history must retain its date without requiring a Released prefix');
assert.match(
    updateEntries[2],
    /<span class="update-meta-version">v1\.6\.5<\/span>/,
    'the older update must be v1.6.5'
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
if (exists(feedbackFile)) {
    const feedbackHtml = read(feedbackFile);
    const feedbackScripts = [...feedbackHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
        .map((match) => localRef(feedbackFile, match[1])).filter(Boolean);
    for (const file of feedbackScripts) assertFile(file, 'feedback asset');
    assertFile('docs/vendor/canvas-confetti.LICENSE', 'canvas-confetti attribution');
    assert(feedbackScripts.includes('docs/vendor/canvas-confetti.browser.js'),
        'feedback success state must load the vendored canvas-confetti build');

    for (const file of feedbackScripts) {
        if (file.endsWith('.js')) new vm.Script(read(file), { filename: file });
    }
    for (const match of feedbackHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        new vm.Script(match[1], { filename: `${feedbackFile}:inline` });
    }
}

const htmlIds = [...popupHtml.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
assert.equal(new Set(htmlIds).size, htmlIds.length, 'popup.html contains duplicate ids');
const idSet = new Set(htmlIds);
const popupRuntime = popupScripts
    .map((script) => localRef(popupFile, script))
    .filter(Boolean)
    .map(read)
    .join('\n');
const photoPermissionRequest = popupRuntime.split('function requestPhotoEmbedPermission', 2)[1]
    ?.split('async function requestAndSavePhotoEmbedPermission', 1)[0] || '';
assert.match(
    photoPermissionRequest,
    /chrome\.permissions\.request\(\{\s*origins:\s*\[PHOTO_EMBED_ORIGIN\]\s*\}\)/,
    'photo permission request must be invoked synchronously from the checkbox user gesture'
);
assert.doesNotMatch(
    photoPermissionRequest,
    /permissions\.contains|await\s+/,
    'no async permission preflight may consume the checkbox user gesture before permissions.request'
);
const photoPermissionConfirmation = popupRuntime
    .split('async function requestAndSavePhotoEmbedPermission', 2)[1]
    ?.split('function handleEmbedPhotosChange', 1)[0] || '';
assert(
    photoPermissionConfirmation.indexOf('requestPhotoEmbedPermission(checkbox)') >= 0 &&
    photoPermissionConfirmation.indexOf('requestPhotoEmbedPermission(checkbox)') <
    photoPermissionConfirmation.indexOf('chrome.storage.local.set'),
    'Continue must open Chrome permission before persisting the one-time acknowledgement'
);
assert.match(
    popupRuntime,
    /if\s*\(!photoPermissionIntroSeen\)\s*\{\s*openPhotoPermissionDialog\(checkbox\)/,
    'the first photo-enable attempt must show the explanation before requesting permission'
);
const photoChoicePersistence = popupRuntime
    .split('async function persistXlsxPhotoChoice', 2)[1]
    ?.split('function applyModeUI', 1)[0] || '';
assert.match(
    photoChoicePersistence,
    /await\s+refreshDownloadPlan\(lastExportState\)/,
    'changing XLSX photo mode must immediately refresh the visible multipart plan'
);
const downloadBusyContract = popupRuntime
    .split('function setDownloadBusy', 2)[1]
    ?.split('function renderDownloadPlan', 1)[0] || '';
for (const control of ['xlsxPhotoLinks', 'xlsxPhotoEmbed']) {
    assert.match(
        downloadBusyContract,
        new RegExp(`${control}\\.disabled\\s*=\\s*busy`),
        `an active download must lock ${control}`
    );
}
const downloadClickContract = popupRuntime
    .split("downloadBtn.addEventListener('click'", 2)[1]
    ?.split("copyBtn.addEventListener('click'", 1)[0] || '';
assert.match(
    downloadClickContract,
    /await\s+pendingXlsxPhotoChoice/,
    'Download must wait for the most recent XLSX photo choice to finish saving'
);
assert.match(
    popupRuntime,
    /canContinueComplete\s*=\s*status\s*===\s*['"]complete['"]\s*&&\s*itemCount\s*>\s*0/,
    'zero-item complete exports must not offer a pointless Resume loop'
);
assert.match(read('popup/theme-init.js'), /XPorterThemes\.apply/,
    'the early theme bootstrap must only opt into light when explicitly saved');
assert.doesNotMatch(workerSource.split('chrome.runtime.onInstalled.addListener', 2)[1], /saveSettings\(/,
    'install must use read-time defaults, never overwrite the first popup edit with an initial snapshot');
assert.match(read('utils/storage.js'), /theme:\s*['"]dark['"]/,
    'new settings must default to dark');
assert.doesNotMatch(
    popupHtml,
    /\bbtn-square\b/,
    'export actions must not regress to fixed square tiles'
);
assert.match(
    popupHtml,
    /id=["']statusActionStack["'][\s\S]*id=["']stopBtn["'][\s\S]*id=["']downloadBtn["'][\s\S]*id=["']copyBtn["']/,
    'Stop, Download, and Copy must share the status action row'
);
assert.match(
    read('popup/popup.css'),
    /\.export-status\s*\{[\s\S]*display:\s*grid[\s\S]*\.status-action-stack\.running-actions\s*\{[\s\S]*display:\s*grid[\s\S]*\.status-action-stack\.txt-actions\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[\s\S]*\.btn\.btn-status-action\s*\{[\s\S]*min-height:\s*44px/,
    'status actions must use compact responsive rows for running, terminal, and TXT states'
);
assert.match(
    popupRuntime,
    /statusActionStack\.classList\.toggle\(['"]running-actions['"],\s*isRunning\)/,
    'running status must activate the full-width Stop layout'
);
for (const key of ['postSafetyBreakEnabled', 'userSafetyBreakEnabled']) {
    assert.match(
        read('utils/storage.js'),
        new RegExp(`${key}:\\s*false`),
        `${key} must be opt-in for missing settings`
    );
}
assert.match(read('popup/popup.css'), /\.progress-fill\.rate-limit[\s\S]*repeating-linear-gradient/,
    'X rate limits must have a distinct striped progress treatment');
assert.match(read('popup/popup.css'), /\.progress-fill\.safety-break[\s\S]*repeating-linear-gradient/,
    'scheduled breaks must have a distinct progress treatment');
assert.match(
    read('popup/popup.css'),
    /\.progress-fill\.stopped\s*\{[\s\S]*animation:\s*none/,
    'a user-stopped export must have its own static progress treatment'
);
assert.match(
    read('popup/popup.css'),
    /\.progress-fill\.stopped::after\s*\{[\s\S]*display:\s*none/,
    'the stopped progress bar must not keep the active-export shine animation'
);
assert.match(
    read('popup/popup.css'),
    /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[\s\S]*\.resume-row\.is-stopped[\s\S]*\.resume-play-icon[\s\S]*animation:/,
    'the stopped Resume cue may breathe only when motion is allowed'
);
assert.match(
    popupRuntime,
    /case\s+['"]stopped['"]:[\s\S]*classList\.add\(['"]phase-stopped['"]\)[\s\S]*classList\.add\(['"]stopped['"]\)/,
    'the stopped state must explicitly apply its own card and progress phases'
);
assert.match(
    popupRuntime,
    /case\s+['"]stopped['"]:[\s\S]*setDotColor\(['"]resumable['"]\)/,
    'the stopped state must replace the generic yellow dot with a resumable cue'
);
assert.match(
    read('popup/theme.js'),
    /playerStop:\s*['"][\s\S]*?<path d=["']M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -10["']/,
    'the stopped title must use the official Tabler player-stop path'
);
assert.match(
    read('popup/theme.js'),
    /playerPlay:\s*['"][\s\S]*?<path d=["']M7 4v16l13 -8l-13 -8["']/,
    'the resumable cue must use the official Tabler player-play path'
);
assert.match(
    popupHtml,
    /class=["'][^"']*resume-play-icon[^"']*["'][\s\S]*?<path d=["']M7 4v16l13 -8l-13 -8["']/,
    'the Resume button must use the official Tabler player-play path'
);
assert.doesNotMatch(
    read('popup/popup.css'),
    /\.status-resumable::after/,
    'the resumable cue must not use a hand-drawn CSS arrow'
);
assert.match(popupRuntime, /state\.kind\s*===\s*['"]batch['"][\s\S]*setStatusPhase\(['"]safety-break['"]\)/,
    'batch cooldowns must render as the user-configured Scheduled break, not as an X rate limit');
assert.match(popupRuntime, /case\s+['"]rate_limited['"]:[\s\S]*setStatusPhase\(['"]rate-limit['"]\)/,
    'real X rate limits must render their own status phase');
assert.match(popupHtml, /id=["']includeAboutAccountDetails["']/,
    'Settings must expose the detailed About this Account opt-in');
const aboutDetailsToggleMarkup = popupHtml.slice(
    popupHtml.indexOf('id="includeAboutAccountDetails"'),
    popupHtml.indexOf('id="aboutAccountOptions"')
);
assert.match(
    aboutDetailsToggleMarkup,
    /class=["'][^"']*\bhelp-local\b[^"']*\bhelp-tall\b[^"']*["']/,
    'About-this-Account help must open below its own settings row'
);
assert.doesNotMatch(
    aboutDetailsToggleMarkup,
    /\bhelp-viewport\b/,
    'About-this-Account help must not be relocated to the top of the popup'
);
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
    popupRuntime,
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
    /id=["']aboutAccountMaxRetries["'][^>]*\bmin=["']15["'][^>]*\bmax=["']1440["']/,
    'the X-limit wait must cover one full 15-minute window and go up to one day'
);
assert.match(
    popupRuntime,
    /aboutAccountOptions\.classList\.toggle\(\s*['"]hidden['"],\s*!includeAboutAccountDetails\.checked\s*\)/,
    'the About dependent settings must track the detailed-enrichment toggle'
);
assert.match(
    read('utils/storage.js'),
    /aboutAccountSpeed:\s*['"]standard['"]/,
    'missing settings must use Standard About concurrency'
);
assert.match(
    read('utils/storage.js'),
    /aboutAccountMaxRetries:\s*C\.RATE_LIMIT_WAIT_RANGE_MINUTES\?\.\[2\]\s*\?\?\s*15/,
    'missing settings must default to waiting one full 15-minute X window'
);
assert.match(
    popupRuntime,
    /aboutAccountMaxRetries:\s*lastAcceptedAboutRetries/,
    'the popup must persist only the accepted About retry setting'
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
    popupHtml,
    /id=["']photoPermissionDialog["'][^>]*\brole=["']dialog["'][^>]*\baria-modal=["']true["']/,
    'photo embedding must explain its optional host access in an accessible dialog'
);
assert.match(popupHtml, /id=["']photoPermissionCancel["']/,
    'the photo permission dialog must let users keep embedding off');
assert.match(popupHtml, /id=["']photoPermissionConfirm["'][^>]*\bdisabled\b/,
    'the photo permission dialog confirmation must start disabled');
assert.match(
    popupRuntime,
    /ABOUT_RETRY_WARNING_THRESHOLD\s*=\s*60/,
    'more than one hour of About retries must require explicit confirmation'
);
assert.match(
    popupRuntime,
    /popup\.inert\s*=\s*true/,
    'opening the About risk dialog must make background controls inert'
);
assert.match(
    read('utils/storage.js'),
    /userExportSpeed:\s*['"]standard['"]/,
    'user-list exports must have an independent Standard speed default'
);
assert.match(popupHtml, /id=["']exportSpeed["']/, 'popup must expose the posts speed control');
assert.match(popupHtml, /id=["']userExportSpeed["']/, 'popup must expose the user-list speed control');
assert.match(
    popupRuntime,
    /if\s*\(resumeAddsItems\)\s*message\.extraItems\s*=\s*resumeExtraItems\(\)/,
    'only a completed export may turn Resume into a +N quantity extension'
);
assert.match(
    popupRuntime,
    /updateUI\(\{\s*\.\.\.lastExportState,\s*running:\s*false,\s*status:\s*['"]stopped['"]/,
    'Stop must preserve partialReason and other export metadata in local popup state'
);
assert.match(
    popupRuntime,
    /partialReason:\s*result\.partialReason\s*\?\?\s*lastExportState\.partialReason\s*\?\?\s*null/,
    'ordinary Resume must preserve the Posts-only partial marker'
);
assert.match(
    read('popup/history.js'),
    /entry\.partialReason\s*===\s*['"]replies_unavailable['"]/,
    'history must visibly distinguish Posts-only fallback exports'
);
assert.match(
    popupRuntime,
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
    for (const key of englishKeys) {
        assert.equal(typeof locale[key], 'string', `${file} ${key} must be a string`);
        const placeholders = value => [...new Set([...value.matchAll(/\{[A-Za-z][A-Za-z0-9_]*\}/g)]
            .map(match => match[0]))].sort();
        assert.deepEqual(placeholders(locale[key]), placeholders(english[key]),
            `${file} ${key} must preserve every interpolation placeholder`);
    }
    for (const key of [
        'formatTxt',
        'xlsxPhotosTitle',
        'xlsxPhotosHelp',
        'xlsxPhotoLinks',
        'xlsxPhotoLinksHelp',
        'xlsxPhotoEmbed',
        'xlsxPhotoEmbedHelp',
        'downloadStagePhotos',
        'downloadStageBuildingXlsx',
        'photoPermissionTitle',
        'photoPermissionBody',
        'photoPermissionCancel',
        'photoPermissionContinue',
        'photoPermissionWaiting',
        'whatToExport',
        'postTypeOriginals',
        'postTypeOriginalsHelp',
        'postTypeQuotes',
        'postTypeQuotesHelp',
        'postTypeReplies',
        'postTypeRepliesHelp',
        'postTypeReposts',
        'postTypeRepostsHelp',
        'postTypeArticles',
        'postTypeArticlesHelp',
        'postSelectionMultiFeed',
        'postSelectionRequired',
        'modeBookmarks',
        'errRepliesUnavailable',
        'repliesUnavailableBody',
        'continuePostsOnly',
        'retryReplies',
        'postsOnlyFallbackActive',
        'postsOnlyFallbackComplete',
        'postsOnlyHistory',
        'sourceExhausted',
        'postSafetyBreaks',
        'userSafetyBreaks',
        'safetyBreakHelp',
        'safetyBreakMinutes',
        'safetyBreakEvery',
        'statusRateLimitTitle',
        'statusRateLimitSubtitle',
        'statusRateLimitHelp',
        'statusSafetyBreakTitle',
        'statusSafetyBreakSubtitle',
        'statusSafetyBreakHelp'
    ]) {
        assert.equal(typeof locale[key], 'string', `${file} must define ${key}`);
        assert(locale[key].trim().length > 0, `${file} must not leave ${key} empty`);
    }
    assert.match(
        locale.photoPermissionBody,
        /^\*\*[^*]+\*\*/,
        `${file} photo permission explanation must lead with a bold summary`
    );
    assert.match(
        locale.photoPermissionBody,
        /pbs\.twimg\.com/,
        `${file} photo permission explanation must name the exact image host`
    );
    assert.match(
        locale.photoPermissionWaiting,
        /\{seconds\}/,
        `${file} photo permission countdown must interpolate the remaining seconds`
    );
    assert.match(
        locale.downloadStagePhotos,
        /\{current\}[\s\S]*\{total\}/,
        `${file} photo progress must interpolate both counters`
    );
    assert.equal(
        locale.postSafetyBreaks,
        locale.userSafetyBreaks,
        `${file} must use the same short Scheduled breaks label in both scoped sections`
    );
    for (const key of ['postsExportSpeedHelp', 'userListsExportSpeedHelp', 'safetyBreakHelp']) {
        const boldMarkers = locale[key].match(/\*\*/g) || [];
        assert.equal(
            boldMarkers.length,
            2,
            `${file} ${key} must bold exactly one important phrase`
        );
        assert.match(
            locale[key],
            /^\*\*[^*]+\*\*/,
            `${file} ${key} must lead with its one bold summary`
        );
    }
    for (const key of ['errRateLimited', 'ovRateLimited', 'statusRateLimitTitle']) {
        assert.match(
            locale[key],
            /X/,
            `${file} ${key} must identify an X rate limit, not a scheduled break`
        );
    }
    if (file !== 'en.json') {
        const localizedAboutSpeedCopy = [
            locale.aboutSpeedFast,
            locale.aboutSpeedCareful,
            locale.aboutSpeedTurtle,
            locale.aboutSpeedCustom,
            locale.aboutAccountSpeedHelp
        ].join(' ');
        assert.doesNotMatch(
            localizedAboutSpeedCopy,
            /\b(?:Fast|Careful|Turtle|Custom)\b/,
            `${file} About-this-Account speed copy must not leave English preset names`
        );
    }
}
assert.doesNotMatch(
    JSON.parse(read('popup/locales/ru.json')).postsExportSpeedHelp,
    /введёт свой лимит|всё равно может применить/i,
    'Russian speed help must describe X rate limits naturally'
);
assert.match(english.aboutDesc, /TXT/, 'English About summary must advertise TXT');
assert.match(english.detailFormatsBody, /TXT/, 'English format details must include TXT');
assert.match(
    popupRuntime,
    /PHOTO_PERMISSION_INTRO_SECONDS\s*=\s*5/,
    'the mandatory photo-permission explanation must guard Continue for five seconds'
);
assert.match(
    popupRuntime,
    /PHOTO_PERMISSION_INTRO_KEY\s*=\s*['"]xporter_photo_permission_intro_seen['"]/,
    'the completed photo-permission explanation must persist exactly once'
);

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

// ==================== Popup review fixes (2026-09-22) ====================
const popupJs = read('popup/popup.js');
const historyJs = read('popup/history.js');
const seenPostsJs = read('popup/seen-posts.js');
const settingsFormJs = read('popup/settings-form.js');
const downloadHandler = popupJs.split('function handleDownloadUpdate', 2)[1]?.split('\n    }\n', 1)[0] || '';
assert.match(downloadHandler, /^\(message\)\s*\{[\s\S]*?if\s*\(message\.source\s*===\s*['"]history['"]\)\s*return;/,
    'history downloads must never lock or relabel the current export controls');
assert.match(popupJs, /EXPORT_COMMAND_TIMEOUT\s*=\s*(\d+)/, 'export commands need an explicit timeout');
assert(Number(/EXPORT_COMMAND_TIMEOUT\s*=\s*(\d+)/.exec(popupJs)[1]) >= 12000,
    'Start/Stop/Resume must outlast the worker stop path (~8 s)');
for (const type of ['START_EXPORT', 'STOP_EXPORT', 'RESUME_EXPORT']) {
    assert.match(popupJs, new RegExp(`${type}[\\s\\S]{0,800}?EXPORT_COMMAND_TIMEOUT`),
        `${type} must use the long export-command timeout`);
}
assert.match(popupJs, /resumeFromRepliesError[\s\S]*?sendMessage\(\{ type \}, EXPORT_COMMAND_TIMEOUT\)/,
    'Posts-only/replies Resume must use the long export-command timeout');
assert.match(popupJs, /result\?\.error\s*===\s*['"]TIMEOUT['"][\s\S]{0,400}?GET_STATUS/,
    'a Stop timeout must re-poll status instead of reporting a failure');
assert.match(popupJs, /\['complete', 'stopped', 'error', 'idle'\]\.includes\(result\?\.status\)/,
    'a Resume reply with a terminal status must render that state, not a running export');
assert.equal((popupJs.match(/await renderRefusedResume\(result\)/g) || []).length, 2,
    'both Resume paths must handle a terminal Resume reply');
assert.match(popupJs, /status: 'stopped',[\s\S]{0,200}?\}\);[\s\S]{0,200}?type: 'GET_STATUS'/,
    'a confirmed Stop must re-read the worker state (it may have saved complete)');
assert.match(popupJs, /startBtn\.disabled\s*=\s*true[\s\S]*?finally\s*\{\s*startBtn\.disabled\s*=\s*false/,
    'Start must stay disabled while its request is pending');
assert.match(popupJs, /resumeBtn\.disabled\s*=\s*true[\s\S]*?finally\s*\{\s*resumeBtn\.disabled\s*=/,
    'Resume must stay disabled while its request is pending');
assert.match(popupJs, /switchingModeLosesRows\(lastExportState\)[\s\S]*?confirmAction\(/,
    'switching modes over unsaved rows must ask for confirmation first');
assert.match(popupJs, /exportMode\.value\s*=\s*committedMode;\s*\n\s*const confirmed/,
    'an unconfirmed mode switch must keep showing the current mode');
assert.match(popupJs, /dateCheck\.checked\s*&&\s*!dateRangeIsUsable\(\)/,
    'an enabled date filter without a usable date must not start a normal feed export');
assert.match(popupJs, /settingsLoaded\s*&&\s*!currentSettings\.language/,
    'the detected language must never be persisted over settings that failed to load');
assert.match(popupJs, /markSettingsUnavailable\(\{\}\)/,
    'a failed settings load must disable persistence for the popup session');
assert.match(historyJs, /HISTORY_DOWNLOAD_TIMEOUT\s*=\s*(\d+)/);
assert(Number(/HISTORY_DOWNLOAD_TIMEOUT\s*=\s*(\d+)/.exec(historyJs)[1]) >= 180000,
    'history XLSX-with-photos downloads may build for minutes');
assert.match(historyJs, /confirmAction\(\{[\s\S]*?clearHistoryTitle[\s\S]*?CLEAR_HISTORY/,
    'Clear all history must be confirmed before deleting');
assert.match(historyJs, /Array\.from\(String\(entry\.displayName/, 'avatar initials must keep surrogate pairs whole');
assert.doesNotMatch(seenPostsJs, /window\.confirm/, 'native confirm is not used in the popup');
assert.match(seenPostsJs, /confirmAction\(\{[\s\S]*?CLEAR_FEED_DB/, 'clearing seen posts must use the guarded dialog');
assert.match(read('popup/account-fields.js'), /avatarUrl\.startsWith\('https:\/\/'\)/,
    'account avatars must only load https images');
assert.match(settingsFormJs, /addEventListener\('pagehide'/, 'pending settings edits must flush when the popup closes');
assert.match(settingsFormJs, /visibilityState\s*===\s*'hidden'/, 'pending settings edits must flush when hidden');
assert.match(settingsFormJs, /showToast\(formatError\(result\?\.error/, 'autosave failures must be visible');
assert.equal((settingsFormJs.match(/quantityLimit\.addEventListener\('change'/g) || []).length, 1);
assert.doesNotMatch(settingsFormJs, /includeBookmarkArticles,\s*quantityLimit,/,
    'quantityLimit must have one change listener (its own handler saves)');
// Popup form fallbacks only display (persistence is refused after a failed
// load), but they must agree with the storage.js defaults.
const storageDefaults = read('utils/storage.js').split('async function loadSettings()', 2)[1];
for (const key of ['includeOriginalPosts', 'includeQuotes', 'includeReplies', 'includeRetweets',
    'includeArticles', 'includeBookmarkReplyContext', 'includeBookmarkArticles',
    'includeAboutAccountDetails', 'postSafetyBreakEnabled', 'userSafetyBreakEnabled',
    'autoExpireEnabled', 'ladybugEnabled', 'localizeExportHeaders']) {
    const storageDefault = new RegExp(`\\n\\s*${key}:\\s*(true|false),`).exec(storageDefaults)?.[1];
    assert(storageDefault, `storage.js must define a boolean default for ${key}`);
    const expected = storageDefault === 'true'
        ? new RegExp(`currentSettings\\.${key}\\s*!==\\s*false`)
        : new RegExp(`currentSettings\\.${key}\\s*===\\s*true`);
    assert.match(settingsFormJs, expected, `settings form fallback for ${key} must match storage.js (${storageDefault})`);
}
assert.match(popupHtml, /id="githubLink"[\s\S]*?data-i18n-aria-label="viewSource"/, 'GitHub link name must be localized');
assert.match(popupHtml, /id="langBtn"[^>]*aria-haspopup="menu"[^>]*aria-controls="langDropdown"/,
    'language button must expose its menu');
assert.match(popupHtml, /id="langDropdown"[^>]*role="menu"/);
assert.match(popupHtml, /id="toastRegion"[^>]*aria-live="polite"/, 'toasts need one persistent live region');
assert.doesNotMatch(read('popup/presentation.js'), /toast\.setAttribute\('role'/,
    'individual toasts must not re-create live regions');
assert.match(popupHtml, /<time data-release-date data-date-style="short" datetime="([^"]+)" class="footer-build-date">/,
    'the footer build date must be localized from its machine-readable date');
assert.equal(/datetime="([^"]+)" class="footer-build-date"/.exec(popupHtml)?.[1], currentBuildDate,
    'the footer date must use the current About build date');
assert.match(popupHtml, /data-i18n-template="authRequired">[^<]*<a data-slot="link"/,
    'the sign-in warning must be one localized sentence around its link');
const themeJs = read('popup/theme.js');
assert.doesNotMatch(themeJs, /function toggleTheme|\bsun:|\bmoon:|\bdownload:/, 'dead theme helpers stay removed');
assert.doesNotMatch(read('popup/theme-init.js').split("chrome.storage.local.get('xporter_settings'", 2)[1] || '',
    /XPorterThemes\.apply\(/, 'theme-init applies the preset once, through XPorterUIAppearance.apply');
const ratePromptJs = read('popup/rate-prompt.js');
assert.doesNotMatch(ratePromptJs, /markDeferred|openBugChannel|BUG_URL|rateReport|mdBold/,
    'dead review-prompt helpers stay removed');
assert.doesNotMatch(popupJs, /onReportBug/);
assert.doesNotMatch(read('popup/presentation.js'), /characterData:\s*true/,
    'Home sizing must not re-measure on every counter digit update');
for (const dir of storeLocaleDirs0()) {
    const description = JSON.parse(read(`_locales/${dir}/messages.json`)).extDescription.message;
    assert([...description].length <= 132, `${dir} store description exceeds the CWS 132-character limit`);
}
assert([...JSON.parse(read('_locales/tr/messages.json')).extDescription.message].length <= 125,
    'Turkish store description keeps a safety margin below the CWS limit');
function storeLocaleDirs0() {
    return fs.readdirSync(path.join(ROOT, '_locales')).sort();
}

const workerCases = new Set([...workerSource.matchAll(/case\s+['"]([A-Z][A-Z0-9_]*)['"]/g)]
    .map((match) => match[1]));
const contentSource = read('content/content.js');
const contentCases = new Set(
    [...contentSource.matchAll(/message\?\.type\s*===\s*['"]([A-Z][A-Z0-9_]*)['"]/g)]
        .map((match) => match[1])
);
const senderSource = popupRuntime + '\n' + contentSource;
const sentToWorker = new Set([...senderSource.matchAll(/type\s*:\s*['"]([A-Z][A-Z0-9_]*)['"]/g)]
    .map((match) => match[1]));
for (const type of sentToWorker) {
    assert(
        workerCases.has(type) || contentCases.has(type),
        `runtime message has no service-worker/content handler: ${type}`
    );
}

const workerEmits = new Set([...workerSource.matchAll(/type\s*:\s*['"]([A-Z][A-Z0-9_]*)['"]/g)]
    .map((match) => match[1]));
const consumerSource = popupRuntime + '\n' + read('content/content.js');
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
