#!/usr/bin/env node

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { withTimeout } = require('./test-extension-core/support.js');

const {
    assertBrowserSmokeCanLaunch,
    requireSofficeExecutable,
    resolveSofficeExecutable
} = require('./tooling-policy.js');

function createPackageFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-package-test-'));
    const scriptsDir = path.join(root, 'scripts');
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(scriptsDir);
    fs.mkdirSync(binDir);
    fs.copyFileSync(path.join(__dirname, 'package.sh'), path.join(scriptsDir, 'package.sh'));
    fs.chmodSync(path.join(scriptsDir, 'package.sh'), 0o755);
    fs.writeFileSync(path.join(root, 'manifest.json'), '{"version":"1.6.1"}\n');
    fs.writeFileSync(path.join(root, 'LICENSE'), 'license\n');
    fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES'), 'notices\n');
    for (const directory of ['background', 'content', 'popup', 'utils', 'icons', '_locales']) {
        fs.mkdirSync(path.join(root, directory));
        fs.writeFileSync(path.join(root, directory, `${directory}.txt`), `${directory}\n`);
    }
    fs.writeFileSync(path.join(binDir, 'node'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'node'), 0o755);
    return { root, scriptsDir, binDir };
}

// Use Node's independent test runner: if the deadline helper itself loses its
// timer, node:test reports cancelled pending work rather than a false pass.
test('test deadlines execute work, propagate failures and reject unresolved promises', async () => {
    let calls = 0;
    assert.equal(await withTimeout(() => { calls++; return 42; }, 'sync fixture'), 42);
    assert.equal(calls, 1);
    await assert.rejects(withTimeout(() => { throw new Error('fixture failure'); }, 'failure fixture'), /fixture failure/);
    await assert.rejects(withTimeout(() => new Promise(() => {}), 'hung fixture', 1), /hung fixture timed out/);
});

test('browser smoke refuses to launch a macOS app inside the Codex sandbox', () => {
    assert.throws(
        () => assertBrowserSmokeCanLaunch({ CODEX_SANDBOX: 'seatbelt' }),
        error => error?.code === 'CODEX_SANDBOX_BROWSER_BLOCKED'
    );
});

test('browser smoke remains available outside the Codex sandbox', () => {
    assert.doesNotThrow(() => assertBrowserSmokeCanLaunch({}));
});

test('browser smoke entrypoint rejects the Codex sandbox before loading Playwright', () => {
    const smokeScript = path.join(__dirname, 'test-extension-smoke.mjs');
    const forbiddenModule = 'xporter-playwright-must-not-load-in-sandbox';
    const result = spawnSync(process.execPath, [smokeScript], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: {
            ...process.env,
            CODEX_SANDBOX: 'seatbelt',
            PLAYWRIGHT_MODULE: forbiddenModule,
            TMPDIR: os.tmpdir()
        }
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;

    assert.notEqual(result.status, 0, 'sandboxed browser smoke must fail');
    assert.match(output, /CODEX_SANDBOX_BROWSER_BLOCKED/);
    assert.doesNotMatch(
        output,
        new RegExp(forbiddenModule),
        'the sandbox guard must run before Playwright module resolution'
    );
});

test('every Playwright entrypoint rejects the Codex sandbox before loading Playwright', () => {
    const forbiddenModule = 'xporter-playwright-must-not-load-in-sandbox';
    const browserEntrypoints = fs.readdirSync(__dirname)
        .filter(name => /\.(?:js|mjs|cjs)$/.test(name))
        .filter(name => {
            const absolute = path.join(__dirname, name);
            if (absolute === __filename) return false;
            const source = fs.readFileSync(absolute, 'utf8');
            return source.includes("'playwright'") || source.includes('"playwright"');
        })
        .sort();

    assert(browserEntrypoints.length > 0, 'at least one Playwright entrypoint must be discovered');
    for (const name of browserEntrypoints) {
        const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            env: {
                ...process.env,
                CODEX_SANDBOX: 'seatbelt',
                PLAYWRIGHT_MODULE: forbiddenModule,
                TMPDIR: os.tmpdir()
            }
        });
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        assert.notEqual(result.status, 0, `${name} must refuse a sandboxed browser launch`);
        assert.match(output, /CODEX_SANDBOX_BROWSER_BLOCKED/,
            `${name} must fail through the shared browser policy`);
        assert.doesNotMatch(output, new RegExp(forbiddenModule),
            `${name} must reject the sandbox before Playwright module resolution`);
    }
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

test('runtime and LibreOffice failures both block release before replacing an artifact', () => {
    for (const failingScript of ['scripts/test-all.js', 'scripts/test-xlsx-libreoffice.js']) {
        const fixture = createPackageFixture();
        const output = path.join(fixture.root, 'existing.zip');
        const previous = Buffer.from('previous-good-artifact');
        fs.writeFileSync(output, previous);
        fs.writeFileSync(path.join(fixture.binDir, 'node'),
            `#!/bin/sh\nif [ "$1" = "${failingScript}" ]; then exit 41; fi\nexit 0\n`);
        try {
            const result = spawnSync(path.join(fixture.scriptsDir, 'package.sh'), [], {
                cwd:fixture.root, encoding:'utf8',
                env:{...process.env, PATH:`${fixture.binDir}:/usr/bin:/bin`, XPORTER_ZIP_OUT:output}
            });
            assert.equal(result.status, 41, `${failingScript} must be a mandatory packaging gate`);
            assert.deepEqual(fs.readFileSync(output), previous);
        } finally {
            fs.rmSync(fixture.root, {recursive:true, force:true});
        }
    }
});

test('package creation failure preserves the previous output artifact', () => {
    const fixture = createPackageFixture();
    const output = path.join(fixture.root, 'existing.zip');
    const previous = Buffer.from('previous-good-artifact');
    fs.writeFileSync(output, previous);
    const failingZip = path.join(fixture.binDir, 'zip');
    fs.writeFileSync(failingZip, '#!/bin/sh\nexit 42\n');
    fs.chmodSync(failingZip, 0o755);

    try {
        const result = spawnSync(path.join(fixture.scriptsDir, 'package.sh'), [], {
            cwd: fixture.root,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fixture.binDir}:/usr/bin:/bin`,
                XPORTER_ZIP_OUT: output
            }
        });

        assert.notEqual(result.status, 0, 'the injected zip failure must fail packaging');
        assert.deepEqual(fs.readFileSync(output), previous,
            'a failed replacement must leave the previous artifact byte-identical');
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('package validation rejects unexpected archive entries without replacing output', () => {
    const fixture = createPackageFixture();
    const output = path.join(fixture.root, 'existing.zip');
    const previous = Buffer.from('previous-good-artifact');
    fs.writeFileSync(output, previous);
    fs.writeFileSync(
        path.join(fixture.binDir, 'zip'),
        '#!/bin/sh\n' +
        '/usr/bin/zip "$@" || exit $?\n' +
        'printf "unexpected\\n" > unexpected-package-entry.txt\n' +
        '/usr/bin/zip -q "$3" unexpected-package-entry.txt\n' +
        'rm -f unexpected-package-entry.txt\n'
    );
    fs.chmodSync(path.join(fixture.binDir, 'zip'), 0o755);

    try {
        const result = spawnSync(path.join(fixture.scriptsDir, 'package.sh'), [], {
            cwd: fixture.root,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fixture.binDir}:/usr/bin:/bin`,
                XPORTER_ZIP_OUT: output
            }
        });

        assert.notEqual(result.status, 0, 'an archive with an unexpected entry must be rejected');
        assert.deepEqual(fs.readFileSync(output), previous,
            'a rejected archive must leave the previous artifact byte-identical');
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
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
