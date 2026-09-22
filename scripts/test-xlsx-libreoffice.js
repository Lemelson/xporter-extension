#!/usr/bin/env node
'use strict';

// Explicit integration gate: missing/broken LibreOffice is a failure, never PASS.
// The deterministic core checks the ZIP and cells independently of this program.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { requireSofficeExecutable } = require('./tooling-policy.js');

// LibreOffice silently truncates a sheet at the first XML-invalid character,
// so this workbook mixes them into every row and checks that all rows survive.
const HOSTILE = 'A￿B￾C\uD800D\uDC00EF';
const ROWS = 40;

function convertSheets(soffice, directory, name, bytes) {
    const workbook = path.join(directory, `${name}.xlsx`);
    fs.writeFileSync(workbook, bytes);
    // Filter token 12 = -1 writes every sheet as <name>-<Sheet>.csv.
    execFileSync(soffice, [
        `-env:UserInstallation=file://${path.join(directory, 'profile')}`,
        '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1',
        '--outdir', directory, workbook
    ], {stdio:'pipe', timeout:60_000});
    const read = sheet => fs.readFileSync(path.join(directory, `${name}-${sheet}.csv`), 'utf8');
    return { read };
}

async function main() {
    const soffice = requireSofficeExecutable();
    assert(soffice, 'LibreOffice is required for the XLSX compatibility gate; install it before release');
    const context = vm.createContext({TextEncoder, Uint8Array, DataView, ArrayBuffer, CompressionStream});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../utils/csv.js'), 'utf8'), context);
    const csv = context.XPorterCSV;
    const simple = csv.generateXLSX([
        {id:'2075277820528607704', text:'Привет & hello', favorite_count:12}
    ]);
    const items = Array.from({length: ROWS}, (_, index) => ({
        id: String(2075277820528607000 + index).slice(0, 19),
        text: `${HOSTILE} row ${index} 1.50`,
        favorite_count: index,
        ...(index === ROWS - 1 ? {hashtags: '#last'} : {})
    }));
    const profile = {name: `Owner ${HOSTILE}`, screenName: 'owner', bio: 'Bio\nline two', followersCount: 123};
    const photo = {
        postId: items[0].id, relation: 'post', sourceUrl: 'https://pbs.twimg.com/media/a.png',
        contentType: 'image/png', extension: 'png', width: 1, height: 1,
        bytes: Uint8Array.from(Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
            'base64'))
    };
    const hostileOpts = {profile, mediaAssets: [photo], mediaSkippedCount: 2};
    const stored = csv.generateXLSX(items, false, hostileOpts);
    const deflated = await csv.generateXLSXAsync(items, false, hostileOpts);
    assert(deflated.length < stored.length, 'the async workbook must be DEFLATE-compressed');

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-office-check-'));
    try {
        const basic = convertSheets(soffice, directory, 'export', simple).read('Export');
        assert(basic.includes('2075277820528607704'), 'LibreOffice must preserve the complete long ID');
        assert(basic.includes('Привет & hello'), 'LibreOffice must preserve Unicode cell text');

        for (const [name, bytes] of [['stored', stored], ['deflated', deflated]]) {
            const sheets = convertSheets(soffice, directory, name, bytes);
            const lines = sheets.read('Export').trim().split('\n');
            assert.equal(lines.length, ROWS + 1, `${name}: every row must survive XML-invalid characters`);
            assert.match(lines[0], /^id,text,favorite_count,hashtags$/, `${name}: header must be row 1`);
            assert(lines[ROWS].includes(`ABCDEF row ${ROWS - 1} 1.50`), `${name}: numeric-looking text stays text`);
            assert(lines[ROWS].endsWith(`,${ROWS - 1},#last`), `${name}: last row must be complete`);
            const profileSheet = sheets.read('Profile');
            assert(profileSheet.includes('Owner ABCDEF') && profileSheet.includes('123'),
                `${name}: the Profile sheet must open`);
            assert(sheets.read('Media').includes('2 more photos were not embedded'),
                `${name}: the Media sheet must open with its note`);
        }
        console.log('PASS LibreOffice opens stored and deflated XLSX (Export/Profile/Media) with every row');
    } finally {
        fs.rmSync(directory, {recursive:true, force:true});
    }
}

main().catch((error) => {
    console.error(`FAIL LibreOffice XLSX compatibility: ${error.message}`);
    process.exitCode = 1;
});
