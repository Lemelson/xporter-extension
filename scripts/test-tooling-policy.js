#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    assertBrowserSmokeCanLaunch,
    requireSofficeExecutable,
    resolveSofficeExecutable
} = require('./tooling-policy.js');

test('browser smoke refuses to launch a macOS app inside the Codex sandbox', () => {
    assert.throws(
        () => assertBrowserSmokeCanLaunch({ CODEX_SANDBOX: 'seatbelt' }),
        error => error?.code === 'CODEX_SANDBOX_BROWSER_BLOCKED'
    );
});

test('browser smoke remains available outside the Codex sandbox', () => {
    assert.doesNotThrow(() => assertBrowserSmokeCanLaunch({}));
});

test('sandboxed soffice resolution prefers the bundled Codex headless runtime', () => {
    const runtime = '/Users/test/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice';
    const executable = resolveSofficeExecutable({
        env: {
            CODEX_SANDBOX: 'seatbelt',
            PATH: '/opt/homebrew/bin:/Users/test/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override'
        },
        homeDir: '/Users/test',
        existsSync: candidate => new Set([
            '/opt/homebrew/bin/soffice',
            runtime
        ]).has(candidate)
    });

    assert.equal(executable, runtime);
});

test('sandboxed soffice resolution rejects a GUI-only installation', () => {
    const executable = resolveSofficeExecutable({
        env: {
            CODEX_SANDBOX: 'seatbelt',
            PATH: '/opt/homebrew/bin:/usr/bin'
        },
        homeDir: '/Users/test',
        existsSync: candidate => candidate === '/opt/homebrew/bin/soffice'
    });

    assert.equal(executable, null);
});

test('sandboxed soffice resolution rejects lookalike cache paths', () => {
    const runtime = '/Users/test/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice';
    const lookalike = '/tmp/.cache/codex-runtimes/lookalike/soffice';
    const executable = resolveSofficeExecutable({
        env: {
            CODEX_SANDBOX: 'seatbelt',
            XPORTER_SOFFICE_EXECUTABLE: lookalike,
            PATH: '/opt/homebrew/bin'
        },
        homeDir: '/Users/test',
        existsSync: candidate => new Set([lookalike, runtime]).has(candidate)
    });

    assert.equal(executable, runtime,
        'only the exact managed Codex runtime may execute inside the sandbox');
});

test('sandboxed soffice requirement fails closed when the managed runtime is missing', () => {
    assert.throws(
        () => requireSofficeExecutable({
            env: { CODEX_SANDBOX: 'seatbelt', PATH: '/opt/homebrew/bin' },
            homeDir: '/Users/test',
            existsSync: candidate => candidate === '/opt/homebrew/bin/soffice'
        }),
        error => error?.code === 'CODEX_SANDBOX_SOFFICE_BLOCKED'
    );
});

test('repository executable sources cannot bypass the sandbox-safe soffice resolver', () => {
    const repositoryRoot = path.join(__dirname, '..');
    const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'work']);
    const unsafeInvocation = /(?:execFileSync|execFile|spawnSync|spawn|execSync)\s*\(\s*['"](?:soffice|libreoffice)['"]|\/Applications\/LibreOffice\.app|\[['"]soffice['"]\s*,\s*['"]libreoffice['"]\]|(?:^|[;&|]\s*)soffice\s/m;
    const offenders = [];

    function inspect(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!ignoredDirectories.has(entry.name)) inspect(path.join(directory, entry.name));
                continue;
            }
            if (!/\.(?:js|mjs|cjs|sh)$/.test(entry.name)) continue;
            const absolute = path.join(directory, entry.name);
            if (absolute === __filename) continue;
            const source = fs.readFileSync(absolute, 'utf8');
            if (unsafeInvocation.test(source)) offenders.push(path.relative(repositoryRoot, absolute));
        }
    }

    inspect(repositoryRoot);

    assert.deepEqual(offenders, [],
        'use resolveSofficeExecutable() or scripts/soffice-headless.js instead of a GUI-backed binary');
});
