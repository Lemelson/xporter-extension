#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SUITES = [
    'scripts/check-capture-bundle.js',
    'scripts/test-static-contracts.js',
    'scripts/test-extension-core.js',
    'scripts/test-rate-limit.js',
    'scripts/test-feed-capture.js',
    'scripts/test-tooling-policy.js',
    'scripts/test-storage-concurrency.js',
    'scripts/test-download-transaction.js',
    'scripts/test-bookmark-context-lifecycle.js',
    'scripts/test-api-discovery-cancellation.js',
    'scripts/test-capture-contract.js',
    'scripts/test-export-policy.js'
];

for (const suite of SUITES) {
    const result = spawnSync(process.execPath, [path.join(ROOT, suite)], {
        cwd: ROOT,
        env: process.env,
        stdio: 'inherit'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`All deterministic tests passed (${SUITES.length} suites).`);
