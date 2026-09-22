#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {harness, oldRows} = require('./feedback-collector-harness.cjs');
const root = path.join(__dirname, '..');
const settings = {language:'ru',theme:'dark',themePreset:'obsidian',simplifiedDesign:true,ladybugEnabled:false,
    popupWidth:125,popupHeight:75,uiScale:110,textScale:120,autoExpireEnabled:false,autoExpireHours:8,
    exportMode:'bookmarks',outputFormat:'txt',includeOriginalPosts:false,includeQuotes:true,
    includeBookmarkReplyContext:false,includeBookmarkArticles:true,embedPostPhotos:false,embedBookmarkPhotos:true,
    includeAboutAccountDetails:true,aboutAccountSpeed:'careful',aboutAccountCustomBatchSize:3,aboutAccountMaxRetries:17};
const expected = {s_colorful:1,s_ladybug:0,s_window_width:125,s_window_height:75,s_element_size:110,s_text_size:120,
    s_auto_expire:0,s_auto_expire_hours:8,s_mode:'bookmarks',s_format:'txt',s_originals:0,s_quotes:1,
    s_bookmark_context:0,s_bookmark_articles:1,s_post_photos:0,s_bookmark_photos:1,s_about:1,
    s_about_speed:'careful',s_about_batch:3,s_about_retries:17,f_txt:2,ladybug_squashes:7,theme_preset:'obsidian'};
const ctx = vm.createContext({TextEncoder,TextDecoder,CompressionStream,DecompressionStream,Response,Blob,btoa,atob,
    XPorterStorage:{loadSettings:async()=>settings,loadUsage:async()=>({byFormat:{txt:2},ladybugSquashes:7})},
    XPorterDiagnostics:{load:async()=>({since:1800000000000,installId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        attempts:[{mode:'posts',format:'csv',settings:{exportSpeed:'turbo'}}],downloads:[],totals:{}})},
    chrome:{runtime:{getManifest:()=>({version:'1.6.5'}),getPlatformInfo:async()=>({os:'mac'}),
        onInstalled:{addListener(){}},onStartup:{addListener(){}}}}
});
for (const file of ['popup/theme-presets.js','utils/diagnostics-codec.js','background/uninstall-feedback.js'])
    vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx);
async function run() {
    const codec = ctx.XPorterDiagnosticsCodec;
    const snapshot = await ctx.XPorterFeedback.snapshot();
    for (const [key,value] of Object.entries(expected)) assert.equal(snapshot[key],value,`snapshot must include ${key}`);
    const url = await codec.buildURL('https://lemelson.github.io/xporter-extension/feedback.html',snapshot);
    assert(url.length<=1023);
    const decodedStats = await codec.decode(new URL(url).searchParams.get('d2'));
    // Execute the actual page forwarding function, then the real collector with an in-memory workbook.
    const html=fs.readFileSync(path.join(root,'docs/feedback.html'),'utf8');
    const forwarding=html.slice(html.indexOf('    const FORWARDED_STAT_KEYS'),html.indexOf('    const isLocalFeedbackPage'));
    const page=vm.createContext({decodedStats,params:{},safeSource:'uninstall',XPorterDiagnosticsCodec:codec});
    vm.runInContext(forwarding,page);
    const stats=page.forwardedAnonymousStats();
    const h=harness();
    assert(h.post({sessionId:'settings-test',source:'uninstall',type:'open',stats}).ok);
    const row=Object.fromEntries(h.sheets.Sheet1.rows[0].map((key,i)=>[key,h.sheets.Sheet1.rows[2][i]??'']));
    for (const [key,value] of Object.entries(expected)) assert.equal(row[key],value,`sheet must preserve ${key}`);
    assert.equal(row.last_attempt_mode,'posts','current selection must not replace last attempt');
    assert.equal(row.last_attempt_format,'csv');
    assert.deepEqual(h.sheets.Sheet1.rows[1].slice(0,oldRows[0].length),oldRows[1]);
    assert(!('s_text_size' in codec.unpack(codec.pack({schema_version:2}).slice(0,60))), 'old payloads remain unknown');
    const invalid={...stats,s_colorful:2,s_window_width:999,s_text_size:101,s_auto_expire_hours:-1,s_mode:'PRIVATE'};
    assert(h.post({sessionId:'invalid-settings',source:'uninstall',type:'open',stats:invalid}).ok);
    const rejected=Object.fromEntries(h.sheets.Sheet1.rows[0].map((key,i)=>[key,h.sheets.Sheet1.rows[3][i]??'']));
    for(const key of ['s_colorful','s_window_width','s_text_size','s_auto_expire_hours','s_mode']) assert.equal(rejected[key],'');
    settings.themePreset = null;
    settings.theme = 'light';
    assert.equal((await ctx.XPorterFeedback.snapshot()).theme_preset, 'classic-light');
    settings.themePreset = 'invalid';
    settings.theme = 'dark';
    assert.equal((await ctx.XPorterFeedback.snapshot()).theme_preset, 'classic-dark');
    console.log('Current settings survive extension, URL, page and collector; old rows and last attempt stay unchanged.');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
