#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
    createProductionRuntime,
    productionSourceHashes
} = require('./lib/production-runtime');
const { createScenarioTransport } = require('./lib/scenario-transport');
const { runProfile } = require('./lib/run-profile');

const LAB_ROOT = __dirname;
const scenarios = JSON.parse(
    fs.readFileSync(path.join(LAB_ROOT, 'fixtures', 'profiles.json'), 'utf8')
);

function parseArgs(argv) {
    const options = {
        sample: 5,
        seed: new Date().toISOString().slice(0, 10),
        all: false,
        out: null
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--all') options.all = true;
        else if (arg === '--sample') options.sample = Number(argv[++index]);
        else if (arg === '--seed') options.seed = argv[++index];
        else if (arg === '--out') options.out = argv[++index];
        else if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage: node test-lab/run.js [--sample 5 | --all] [--seed value] [--out directory]',
                '',
                'Runs the real XPorter API/parsing/export code against an offline X transport.',
                'The seed makes the random profile selection reproducible.'
            ].join('\n'));
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!Number.isInteger(options.sample) || options.sample < 1) {
        throw new Error('--sample must be a positive integer');
    }
    if (!options.seed) throw new Error('--seed must not be empty');
    return options;
}

function seededRandom(seed) {
    let state = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
    return () => {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function pickScenarios(pool, count, seed) {
    const random = seededRandom(seed);
    const copy = [...pool];
    for (let index = copy.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(random() * (index + 1));
        [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy.slice(0, Math.min(count, copy.length));
}

function safeSegment(value) {
    return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

function writeMode(profileDirectory, modeResult) {
    const base = safeSegment(modeResult.mode);
    fs.writeFileSync(path.join(profileDirectory, `${base}.csv`), modeResult.csv, 'utf8');
    fs.writeFileSync(path.join(profileDirectory, `${base}.json`), modeResult.json + '\n', 'utf8');
    fs.writeFileSync(path.join(profileDirectory, `${base}.xlsx`), Buffer.from(modeResult.xlsx));
    if (modeResult.txt) {
        fs.writeFileSync(path.join(profileDirectory, `${base}.txt`), modeResult.txt, 'utf8');
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const selected = options.all
        ? scenarios
        : pickScenarios(scenarios, options.sample, options.seed);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputRoot = path.resolve(
        options.out || path.join(LAB_ROOT, 'output', `${timestamp}_${safeSegment(options.seed)}`)
    );
    fs.mkdirSync(outputRoot, { recursive: true });

    const summaries = [];
    for (const scenario of selected) {
        const transport = createScenarioTransport(scenario);
        const runtime = createProductionRuntime(transport.fetch);
        const result = await runProfile({ scenario, runtime });
        const profileDirectory = path.join(outputRoot, scenario.username);
        fs.mkdirSync(profileDirectory, { recursive: true });

        const modes = [
            result.posts,
            result.postsWithReplies,
            result.bookmarks,
            result.followers,
            result.following,
            result.verifiedFollowers
        ];
        for (const mode of modes) writeMode(profileDirectory, mode);

        summaries.push({
            username: scenario.username,
            variant: scenario.variant,
            rowCounts: Object.fromEntries(modes.map((mode) => [mode.mode, mode.rows.length])),
            requests: transport.requests
        });
        console.log(`PASS @${scenario.username} — posts, replies, bookmarks, followers, following, verified`);
    }

    const summary = {
        passed: true,
        offline: true,
        seed: options.seed,
        selectedProfiles: selected.map((scenario) => scenario.username),
        productionSourceHashes: productionSourceHashes(),
        profiles: summaries,
        generatedAt: new Date().toISOString()
    };
    fs.writeFileSync(
        path.join(outputRoot, 'summary.json'),
        JSON.stringify(summary, null, 2) + '\n',
        'utf8'
    );

    console.log('');
    console.log(`PASS ${selected.length}/${selected.length} profiles`);
    console.log(`Artifacts: ${outputRoot}`);
}

main().catch((error) => {
    console.error(`FAIL ${error.stack || error.message}`);
    process.exitCode = 1;
});
