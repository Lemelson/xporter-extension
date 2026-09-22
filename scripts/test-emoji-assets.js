'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const dir = path.join(root, 'popup/emoji');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
const supported = new Set(manifest.emoji.map(entry => entry.emoji));
for (const entry of manifest.emoji) {
    const expectedVendor = {'⚠️':'Twemoji','👥':'Twemoji','🔖':'Emojitwo','🌐':'Microsoft Fluent Color'}[entry.emoji] || 'Google Noto';
    assert.equal(entry.vendor, expectedVendor, `selected artwork for ${entry.emoji}`);
    const source = fs.readFileSync(path.join(dir, entry.sourceFile));
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), entry.sourceSha256, entry.sourceFile);
    const image = fs.readFileSync(path.join(dir, entry.file));
    assert.equal(crypto.createHash('sha256').update(image).digest('hex'), entry.sha256, entry.file);
    assert.equal(image.readUInt32BE(16), 72, `${entry.file} width`);
    assert.equal(image.readUInt32BE(20), 72, `${entry.file} height`);
}
// Text-presentation symbols (©, ↔, ▶) are not emoji and must stay ordinary text.
const emojiPattern = /\p{Regional_Indicator}{2}|\p{Extended_Pictographic}\uFE0F|\p{Emoji_Presentation}/gu;
function scan(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['vendor', 'emoji'].includes(item.name)) continue;
        const file = path.join(directory, item.name);
        if (item.isDirectory()) scan(file);
        else if (/\.(html|js|json)$/.test(file)) {
            for (const match of fs.readFileSync(file, 'utf8').matchAll(emojiPattern)) {
                assert(supported.has(match[0]), `${path.relative(root, file)}: missing bundled emoji ${match[0]}`);
            }
        }
    }
}
for (const folder of ['popup', 'content', 'docs']) scan(path.join(root, folder));
const font = fs.readFileSync(path.join(dir, 'ui-emoji.woff2'));
assert.equal(font.subarray(0, 4).toString(), 'wOF2');
assert.deepEqual(font, fs.readFileSync(path.join(root, 'docs/assets/ui-emoji.woff2')), 'website font must match extension');
console.log(`PASS ${supported.size} emoji assets, hashes, source coverage and website copy`);

const policy = fs.readFileSync(path.join(root, 'popup/emoji-platform.js'), 'utf8');
for (const [platform, expected] of [['MacIntel', 'apple'], ['macOS', 'apple'], ['iPad', 'apple'], ['Win32', 'bundled'], ['Windows', 'bundled'], ['Linux x86_64', 'bundled']]) {
    for (const useData of [false, true]) {
        const document = { documentElement: { dataset: {} } };
        vm.runInNewContext(policy, { document, navigator: useData ? {userAgentData: {platform}} : {platform} });
        assert.equal(document.documentElement.dataset.emojiPlatform, expected, platform);
    }
}
assert.equal(policy, fs.readFileSync(path.join(root, 'docs/assets/emoji-platform.js'), 'utf8'));
assert(!fs.existsSync(path.join(dir, 'apple-emoji.woff2')), 'Apple artwork must not ship');
