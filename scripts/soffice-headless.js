#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { resolveSofficeExecutable } = require('./tooling-policy.js');

const soffice = resolveSofficeExecutable();
if (!soffice) {
    console.error(
        'No sandbox-safe headless LibreOffice runtime is available. ' +
        'Do not run the macOS LibreOffice.app binary inside CODEX_SANDBOX.'
    );
    process.exitCode = 1;
} else {
    const result = spawnSync(soffice, ['--headless', ...process.argv.slice(2)], {
        stdio: 'inherit'
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
}
