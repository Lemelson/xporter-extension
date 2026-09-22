#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ID = '1P-X_y88WQQb5vU7BIL5uR_477G6BiLWMtWxf7P0clss';
class Sheet {
    constructor(rows = []) { this.rows = structuredClone(rows); }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
    appendRow(row) { this.rows.push(Array.from(row)); }
    setFrozenRows() {}
    getRange(row, col, height = 1, width = 1) {
        return {
            getValues: () => Array.from({length:height}, (_, y) => Array.from({length:width}, (_, x) => this.rows[row+y-1]?.[col+x-1] ?? '')),
            setValues: values => values.forEach((line, y) => line.forEach((value, x) => {
                this.rows[row+y-1] ||= []; this.rows[row+y-1][col+x-1] = value;
            }))
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
