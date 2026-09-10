#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, 'build-site.cjs'), '--check'], { stdio: 'inherit' });
const root = path.resolve(__dirname, '../docs');
const origin = 'https://lemelson.github.io/xporter-extension/';
for (const [file, lang, headline] of [['index.html', 'en', 'Export'], ['ru/index.html', 'ru', 'Экспорт']]) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const canonical = origin + (lang === 'ru' ? 'ru/' : '');
  assert.ok(html.includes(`rel="canonical" href="${canonical}"`), `${file}: stable canonical`);
  assert.ok(html.includes(`<html lang="${lang}"`), `${file}: static language`);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, new RegExp(`<h1[^>]*>${headline}`));
  assert.ok(!/href="#"/.test(html), `${file}: links work without JavaScript`);
  for (const section of ['features', 'datasets', 'formats', 'how', 'privacy', 'faq', 'growth']) {
    assert.ok(html.includes(`id="${section}"`), `${file}: ${section} available in HTML`);
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size, `${file}: unique IDs`);
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|data:)/.test(target)) continue;
    if (target.startsWith('#')) { assert.ok(ids.includes(target.slice(1)), `${file}: ${target}`); continue; }
    const local = path.resolve(path.dirname(path.join(root, file)), target.split('#')[0].split('?')[0]);
    assert.ok(fs.existsSync(local), `${file}: missing ${target}`);
  }
  const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const app = schema['@graph'].find(x => x['@type'] === 'SoftwareApplication');
  assert.equal(app.offers.price, '0');
  assert.equal(app.softwareVersion, '2.0.0');
  assert.ok(!app.aggregateRating, 'Do not invent or freeze Store ratings');
  assert.ok(html.includes('hreflang="en"') && html.includes('hreflang="ru"'));
  const image = fs.readFileSync(path.join(root, 'assets/social-preview.png'));
  assert.equal(image.readUInt32BE(16), 1200, 'Social preview width matches metadata');
  assert.equal(image.readUInt32BE(20), 630, 'Social preview height matches metadata');
}
const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
assert.ok(sitemap.includes(origin + 'ru/'));
assert.ok(!sitemap.includes('feedback.html'), 'Uninstall feedback is not a search landing page');
assert.match(fs.readFileSync(path.join(root, 'feedback.html'), 'utf8'), /name="robots" content="noindex, follow"/);
assert.match(fs.readFileSync(path.join(root, '404.html'), 'utf8'), /noindex/);
assert.ok(fs.readFileSync(path.join(root, 'llms.txt'), 'utf8').includes('llms-full.txt'));
assert.ok(!/\.reveal\s*\{[^}]*opacity:\s*0/.test(fs.readFileSync(path.join(root, 'assets/site.css'), 'utf8')), 'Content stays visible without JavaScript');
console.log('Site checks passed: static EN/RU, links, schema, sitemap, crawler files and no-JS visibility.');
