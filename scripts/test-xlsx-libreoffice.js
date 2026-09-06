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

function main() {
    const soffice = requireSofficeExecutable();
    assert(soffice, 'LibreOffice is required for the XLSX compatibility gate; install it before release');
    const context = vm.createContext({TextEncoder, Uint8Array, DataView, ArrayBuffer});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../utils/csv.js'), 'utf8'), context);
    const bytes = context.XPorterCSV.generateXLSX([
        {id:'2075277820528607704', text:'Привет & hello', favorite_count:12}
    ]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-office-check-'));
    try {
        const workbook = path.join(directory, 'export.xlsx');
        fs.writeFileSync(workbook, bytes);
        execFileSync(soffice, [
            `-env:UserInstallation=file://${path.join(directory, 'profile')}`,
            '--headless', '--convert-to', 'csv', '--outdir', directory, workbook
        ], {stdio:'pipe', timeout:30_000});
        const converted = fs.readFileSync(path.join(directory, 'export.csv'), 'utf8');
        assert(converted.includes('2075277820528607704'), 'LibreOffice must preserve the complete long ID');
        assert(converted.includes('Привет & hello'), 'LibreOffice must preserve Unicode cell text');
        console.log('PASS LibreOffice opens the generated XLSX and preserves ID/text');
    } finally {
        fs.rmSync(directory, {recursive:true, force:true});
    }
}

try { main(); }
catch (error) {
    console.error(`FAIL LibreOffice XLSX compatibility: ${error.message}`);
    process.exitCode = 1;
}
