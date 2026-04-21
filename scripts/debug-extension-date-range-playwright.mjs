import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const USERNAME = process.argv[2] || 'Hongnumongol99';
const DATE_FROM = process.argv[3] || '2025-01-01';
const DATE_TO = process.argv[4] || '2025-12-31';
const LIMIT = Number(process.argv[5] || 100);
const EXT_PATH = path.resolve(process.cwd());
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
  const tmp = path.join(os.tmpdir(), `xporter-extension-debug-${Date.now()}.db`);
  fs.copyFileSync(browserSource.cookiesDb, tmp);

  const rowsRaw = execFileSync('sqlite3', [
    tmp,
    "select host_key,name,path,is_secure,expires_utc,hex(encrypted_value) from cookies where (host_key='.x.com' or host_key='.twitter.com' or host_key='x.com' or host_key='twitter.com') and encrypted_value != X'';"
  ], { encoding: 'utf8', maxBuffer: 50_000_000 }).trim();
  const rows = rowsRaw ? rowsRaw.split('\n').filter(Boolean) : [];

  const metaVersion = Number(
    execFileSync('sqlite3', [tmp, "select value from meta where key='version';"], { encoding: 'utf8' }).trim()
  );
  fs.unlinkSync(tmp);

  const secret = execFileSync('security', ['find-generic-password', '-s', browserSource.keychainService, '-w'], {
    encoding: 'utf8'
  }).trim();
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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-extension-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`
    ]
  });

  try {
    await context.addCookies(decryptCookies());
    await sleep(5000);

    const serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      throw new Error('Extension service worker did not start.');
    }

    const extensionId = new URL(serviceWorker.url()).host;
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await popupPage.evaluate(async ({ limit }) => {
      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: {
          quantityLimit: limit
        }
      });
    }, { limit: LIMIT });

    const startResult = await popupPage.evaluate(async ({ username, dateFrom, dateTo }) => {
      return chrome.runtime.sendMessage({
        type: 'START_EXPORT',
        username,
        exportMode: 'posts',
        outputFormat: 'csv',
        dateFrom,
        dateTo
      });
    }, {
      username: USERNAME,
      dateFrom: DATE_FROM,
      dateTo: DATE_TO
    });

    if (startResult?.error) {
      throw new Error(startResult.error);
    }

    const snapshots = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(3000);
      const status = await popupPage.evaluate(async () => chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
      snapshots.push({
        attempt,
        status: status?.status || null,
        running: !!status?.running,
        tweetCount: status?.tweetCount || 0,
        error: status?.error || null
      });

      if (!status?.running) {
        console.log(JSON.stringify({
          username: USERNAME,
          dateFrom: DATE_FROM,
          dateTo: DATE_TO,
          limit: LIMIT,
          finalStatus: status?.status || null,
          tweetCount: status?.tweetCount || 0,
          error: status?.error || null,
          snapshots
        }, null, 2));
        return;
      }
    }

    const status = await popupPage.evaluate(async () => chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
    console.log(JSON.stringify({
      username: USERNAME,
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      limit: LIMIT,
      finalStatus: status?.status || null,
      tweetCount: status?.tweetCount || 0,
      error: status?.error || null,
      snapshots
    }, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
