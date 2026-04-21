import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const USERNAME = process.argv[2] || 'Hongnumongol99';
const DATE_FROM = process.argv[3] || '2025-01-01';
const DATE_TO = process.argv[4] || '2025-12-31';
const BROWSER_CANDIDATES = [
  {
    cookiesDb: path.join(os.homedir(), 'Library', 'Application Support', 'Comet', 'Default', 'Cookies'),
    keychainService: 'Comet Safe Storage'
  },
  {
    cookiesDb: path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies'),
    keychainService: 'Chrome Safe Storage'
  }
];

function resolveBrowserSource() {
  const match = BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate.cookiesDb));
  if (!match) {
    throw new Error('No supported Chromium cookie database found (checked Comet and Google Chrome).');
  }
  return match;
}

function decryptCookies() {
  const browserSource = resolveBrowserSource();
  const tmp = path.join(os.tmpdir(), 'xporter-debug-cookies.db');
  fs.copyFileSync(browserSource.cookiesDb, tmp);

  const rows = execFileSync('sqlite3', [
    tmp,
    "select host_key,name,path,is_secure,expires_utc,hex(encrypted_value) from cookies where (host_key='.x.com' or host_key='.twitter.com' or host_key='x.com') and encrypted_value != X'';"
  ], { encoding: 'utf8', maxBuffer: 50_000_000 }).trim().split('\n').filter(Boolean);

  const metaVersion = Number(execFileSync('sqlite3', [tmp, "select value from meta where key='version';"], { encoding: 'utf8' }).trim());
  const secret = execFileSync('security', ['find-generic-password', '-s', browserSource.keychainService, '-w'], { encoding: 'utf8' }).trim();
  const key = crypto.pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, ' ');

  return rows.map((line) => {
    const [domain, name, cookiePath, isSecure, expiresUtc, hex] = line.split('|');
    const enc = Buffer.from(hex, 'hex');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    let dec = Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()]);
    const pad = dec[dec.length - 1];
    dec = dec.subarray(0, dec.length - pad);
    if (metaVersion >= 24) dec = dec.subarray(32);

    return {
      name,
      value: dec.toString('utf8'),
      domain,
      path: cookiePath || '/',
      secure: isSecure === '1',
      httpOnly: false,
      sameSite: 'Lax',
      expires: Number(expiresUtc) === 0 ? -1 : (Number(expiresUtc) / 1_000_000) - 11644473600
    };
  });
}

function collectTweetDates(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectTweetDates(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;

  const result = node.tweet_results?.result || node.itemContent?.tweet_results?.result;
  if (result?.legacy?.created_at) {
    out.push(new Date(result.legacy.created_at));
  }

  for (const value of Object.values(node)) {
    collectTweetDates(value, out);
  }

  return out;
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0' });
  await context.addCookies(decryptCookies());

  const page = await context.newPage();
  let captured = null;

  page.on('response', async (response) => {
    if (captured || response.status() !== 200 || !response.url().includes('/SearchTimeline')) return;
    captured = {
      url: response.url(),
      json: await response.json()
    };
  });

  const untilExclusive = new Date(`${DATE_TO}T00:00:00.000Z`);
  untilExclusive.setUTCDate(untilExclusive.getUTCDate() + 1);
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(`(from:${USERNAME}) since:${DATE_FROM} until:${untilExclusive.toISOString().slice(0, 10)}`)}&src=typed_query&f=live`;

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 20 && !captured; i++) {
    await page.waitForTimeout(1000);
  }

  if (!captured) {
    throw new Error('SearchTimeline response was not captured');
  }

  const dates = collectTweetDates(captured.json).filter((d) => !isNaN(d)).sort((a, b) => b - a);
  console.log(JSON.stringify({
    username: USERNAME,
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    searchTimelineUrl: captured.url,
    resultCount: dates.length,
    newest: dates[0]?.toISOString() || null,
    oldest: dates.at(-1)?.toISOString() || null
  }, null, 2));

  await browser.close();
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
