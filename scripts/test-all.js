#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SUITES = [
    'scripts/test-emoji-assets.js',
    'scripts/test-ladybug.js',
    'scripts/test-settings-telemetry.js',
    'scripts/test-diagnostics.js',
    'scripts/test-diagnostics-codec.js',
    'scripts/test-feedback-collector.js',
    'scripts/test-usage-upload.js',
    'scripts/test-site.cjs',
    'scripts/test-feedback-v2-compat.cjs',
    'scripts/test-feedback-clarifications.cjs',
    'scripts/check-capture-bundle.js',
    'scripts/test-theme-presets.cjs',
    'scripts/test-static-contracts.js',
    'scripts/test-i18n-runtime.js',
    'scripts/test-extension-core.js',
    'scripts/test-rate-limit.js',
    'scripts/test-feed-capture.js',
    'scripts/test-tooling-policy.js',
    'scripts/test-storage-concurrency.js',
    'scripts/test-download-transaction.js',
    'scripts/test-pdf-alt.js',
    'scripts/test-bookmark-context-lifecycle.js',
    'scripts/test-export-persistence.js',
    'scripts/test-api-discovery-cancellation.js',
    'scripts/test-capture-contract.js',
    'scripts/test-export-policy.js',
    'scripts/test-worker-lifecycle.js'
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
