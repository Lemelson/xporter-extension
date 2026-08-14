#!/usr/bin/env node

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    assertBrowserSmokeCanLaunch,
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
