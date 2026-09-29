#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ID = '1P-X_y88WQQb5vU7BIL5uR_477G6BiLWMtWxf7P0clss';
// A live formula cell. The collector must never produce one from user input.
class Formula { constructor(source) { this.source = source; } }
// Mirrors how Google Sheets parses setValues()/appendRow() input: a leading
// apostrophe forces text and is dropped from the stored value (getValues()
// never returns it); plain-text ('@') cells keep the literal string; otherwise
// numbers are parsed and =, +, -, @ (also after whitespace) start a formula.
function parseInput(value, format) {
    if (typeof value !== 'string') return value;
    if (value.startsWith("'")) return value.slice(1);
    if (format === '@') return value;
    if (/^[+-]?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
    if (/^\s*[=+@-]/.test(value)) return new Formula(value);
    return value;
}
function a1(ref) {
    const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(ref);
    let column = 0;
    for (const char of letters) column = column * 26 + char.charCodeAt(0) - 64;
    return [Number(row), column];
}
class Sheet {
    constructor(rows = []) { this.rows = structuredClone(rows); this.formats = new Map(); }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
    format(row, col) { return this.formats.get(row + ':' + col) || ''; }
    store(row, col, value) {
        this.rows[row-1] ||= [];
        this.rows[row-1][col-1] = parseInput(value, this.format(row, col));
    }
    appendRow(row) { const index = this.rows.length + 1; Array.from(row).forEach((value, i) => this.store(index, i+1, value)); }
    setFrozenRows() {}
    getRangeList(refs) {
        return { setNumberFormat: format => refs.forEach(ref => { const [row, col] = a1(ref); this.formats.set(row + ':' + col, format); }) };
    }
    getRange(row, col, height = 1, width = 1) {
        return {
            getValues: () => Array.from({length:height}, (_, y) => Array.from({length:width}, (_, x) => this.rows[row+y-1]?.[col+x-1] ?? '')),
            setValues: values => values.forEach((line, y) => line.forEach((value, x) => this.store(row+y, col+x, value)))
        };
    }
}
const oldRows = [['received','sessionId','source','reason','detail','installed_at','lived_min'],
    ['2026-07-01T00:00:00Z','legacy-session','uninstall','r_slow','old comment','2026-06-30T00:00:00Z',1440]];
function harness(sheetId = ID) {
    const sheets = {Sheet1:new Sheet(oldRows)};
    const workbook = {getId:()=>sheetId, getSheetByName:name=>sheets[name], insertSheet:name=>(sheets[name]=new Sheet())};
    const ctx = vm.createContext({console, Date, JSON, Object, Array, Set, Number, String, Math,
        SpreadsheetApp:{getActiveSpreadsheet:()=>workbook},
        LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
        Utilities:{formatDate:date=>date.toISOString().replace(/\.\d+Z$/, 'Z')},
        ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})}
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../backend/apps-script.gs'),'utf8'),ctx);
    return {ctx,sheets, post:payload=>ctx.doPost({postData:{contents:JSON.stringify(payload)}})};
}

module.exports={harness,oldRows,ID};
