'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { source } = require('./support.js');
const { createWorkerHarness } = require('./worker-harness.js');

function searchPage(rows = [], cursor = null) {
    const entries = rows.map(row => ({entryId: 'tweet-' + row.id, content: {itemContent: {tweet_results: {result: {
        legacy: {id_str: row.id, full_text: row.id, created_at: row.date},
        core: {user_results: {result: {rest_id: row.authorId || '1', core: {screen_name: row.username || 'test'}}}}
    }}}}}));
    if (cursor) entries.push({entryId:'cursor-bottom-' + cursor, content:{value:cursor}});
    const instructions = [{type:'TimelineAddEntries',entries}];
    // Synthetic terminal page, not a captured live-X response.
    if (!cursor) instructions.push({type:'TimelineTerminateTimeline', direction:'Bottom'});
    return {url:cursor || 'last-page', status:200, bodyText:JSON.stringify({data:{search_by_raw_query:{search_timeline:{timeline:{instructions}}}}})};
}

function createSearchHarness(pages) {
    const harness = createWorkerHarness();
    const context = harness.context;
    vm.runInContext(source('utils/api-parsers.js'), context);
    context.__pages = [...pages];
    vm.runInContext(`
        currentExport = {
            username:'test',userId:'1',userInfo:{screenName:'test'},exportMode:'posts',outputFormat:'csv',
            schemaVersion:XPORTER_CONFIG.EXPORT_STATE_SCHEMA_VERSION,
            dateFrom:new Date('2026-09-05T00:00:00Z'),dateTo:new Date('2026-09-05T23:59:59.999Z'),
            dateSnapshotAt:Date.parse('2026-09-05T12:00:00Z'),startedAt:Date.parse('2026-09-05T12:00:00Z'),
            running:true,status:'fetching',settings:{quantityLimit:500},tweetBuffer:[],tweetCount:0,totalBatches:0,
            cursor:null,completionReason:null
        };
        rateLimiter={totalRequests:0,batchSize:20,getState:()=>({})};
        XPorterStorage.MAX_TWEETS_PER_BATCH=50;
        XPorterAPI.parseSearchTimelineResponse=XPorterApiParsers.parseSearchTimelineResponse;
        openSearchCaptureTab=async(rawQuery)=>{searchCapture={rawQuery,queue:[],seenUrls:new Set(),resumeScanned:0};};
        closeSearchCaptureTab=async()=>{};
        sendSearchCaptureStatus=async()=>true;
        waitForSearchCapturePayload=async()=>__pages.shift() || null;
        requestNextSearchCapturePayload=async()=>__pages.shift() || null;
        recoverStalledSearchCapture=async()=>null;
        swSleep=async()=>{};
    `,context);
    return harness;
}

async function testSearchErrorsNeverBecomeEmptySuccess() {
    const invalidInstructions = [{type:'UnknownShape'}, {type:'TimelineAddEntries'}, {type:'TimelineShowAlert'}];
    for (const value of [{errors:[{message:'temporary'}]}, {}, ...invalidInstructions.map(instruction =>
        ({data:{search_by_raw_query:{search_timeline:{timeline:{instructions:[instruction]}}}}}))]) {
        const harness=createSearchHarness([{status:200,url:'error-page',bodyText:JSON.stringify(value)}]);
        await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()',harness.context), /SEARCH_(RESPONSE_ERROR|INVALID_RESPONSE)/);
        assert.equal(vm.runInContext('currentExport.completionReason',harness.context),null);
    }
    const harness=createSearchHarness([{status:200,url:'bad-json',bodyText:'{'}]);
    await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()',harness.context),/SEARCH_INVALID_RESPONSE/);
    const invalidRow = createSearchHarness([searchPage([
        {id:'saved-before-error',date:'2026-09-05T01:00:00Z'}, {id:'invalid-date',date:'invalid'}
    ])]);
    await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()', invalidRow.context), /SEARCH_INVALID_RESPONSE/);
    assert.deepEqual(invalidRow.getSavedBatches().flat().map(row => row.id), ['saved-before-error']);
}

async function testSearchTodayIncludesExactBoundsAndFreezesNow() {
    const harness=createSearchHarness([
        searchPage([{id:'late',date:'2026-09-05T11:30:00Z'},{id:'after-snapshot',date:'2026-09-05T12:00:01Z'}],'second'),
        searchPage([{id:'midnight',date:'2026-09-05T00:00:00Z'},{id:'before',date:'2026-09-04T23:59:59Z'},
            {id:'foreign',date:'2026-09-05T01:00:00Z',authorId:'2'},
            {id:'last',date:'2026-09-05T12:00:00Z'}])
    ]);
    await vm.runInContext('_fetchPostsByDateRangeLoop()',harness.context);
    assert.deepEqual(harness.getSavedBatches().flat().map(row=>row.id),['late','midnight','last']);
    assert.equal(harness.getSavedState().completionReason,'source_exhausted');
    assert.equal(harness.getSavedState().dateSnapshotAt,Date.parse('2026-09-05T12:00:00Z'));
    assert.match(vm.runInContext('searchCapture.rawQuery',harness.context),/since:2026-09-04 until:2026-09-07/);
}

async function testSearchSilenceNeverUsesDateCoverage() {
    for (const date of ['2026-09-05T11:30:00Z','2026-09-05T00:01:00Z']) {
        const harness=createSearchHarness([searchPage([{id:'saved',date}],'more')]);
        await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()',harness.context),/SEARCH_STALLED/);
        assert.equal(harness.getSavedState().tweetCount,1,'rows must be durable before the next-page wait');
        assert.equal(harness.getSavedState().completionReason,null,'neither high nor low coverage proves completion');
    }
    const empty=createSearchHarness([searchPage([],'more')]);
    await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()',empty.context),/SEARCH_STALLED/);
}

async function testSearchEmptyLimitAndStopReasons() {
    const empty=createSearchHarness([searchPage([])]);
    await vm.runInContext('_fetchPostsByDateRangeLoop()',empty.context);
    assert.equal(empty.getSavedState().completionReason,'no_matches');
    const limited=createSearchHarness([searchPage([{id:'1',date:'2026-09-05T01:00:00Z'},{id:'2',date:'2026-09-05T02:00:00Z'}],'more')]);
    vm.runInContext('currentExport.settings.quantityLimit=1',limited.context);
    await vm.runInContext('_fetchPostsByDateRangeLoop()',limited.context);
    assert.equal(limited.getSavedState().completionReason,'limit_reached');
    assert.equal(limited.getSavedState().tweetCount,1);
    const stopped=createSearchHarness([searchPage([{id:'1',date:'2026-09-05T01:00:00Z'}],'more')]);
    vm.runInContext('requestNextSearchCapturePayload=async()=>{currentExport.running=false;return null;}',stopped.context);
    await vm.runInContext('_fetchPostsByDateRangeLoop()',stopped.context);
    assert.equal(stopped.getSavedState().completionReason,null);
    assert.equal(stopped.getSavedState().tweetCount,1);
}

async function testSearchResumeDedupAndFailureRecovery() {
    const harness=createSearchHarness([searchPage([{id:'saved',date:'2026-09-05T01:00:00Z'},{id:'new',date:'2026-09-05T02:00:00Z'}])]);
    harness.getSavedBatches()[0]=[{id:'saved'}];
    harness.context.XPorterStorage.loadAllTweets=async()=>[{id:'saved'}];
    vm.runInContext('currentExport.tweetCount=1;currentExport.totalBatches=1;currentExport.dateResume=true;',harness.context);
    await vm.runInContext('_fetchPostsByDateRangeLoop()',harness.context);
    assert.deepEqual(harness.getSavedBatches().flat().map(row=>row.id),['saved','new']);
    assert.equal(vm.runInContext('searchCapture.resumeScanned',harness.context),1);
    const recovered=searchPage([{id:'ok',date:'2026-09-05T02:00:00Z'}]);
    recovered.url='same';
    const retry=createSearchHarness([{url:'same',status:200,bodyText:'{'},recovered]);
    await vm.runInContext('_fetchPostsByDateRangeLoop()',retry.context);
    assert.equal(retry.getSavedState().tweetCount,1);
}


async function testSearchRetryCannotSkipFailedPage() {
    const failed = searchPage([{id:'lost',date:'2026-09-05T01:00:00Z'}], 'page-a');
    const body = JSON.parse(failed.bodyText);
    body.errors = [{message:'partial response'}];
    failed.bodyText = JSON.stringify(body);
    const later = searchPage([{id:'later',date:'2026-09-05T02:00:00Z'}]);
    const gap = createSearchHarness([failed, later]);
    await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()', gap.context), /SEARCH_RESPONSE_ERROR/);
    assert.equal(vm.runInContext('currentExport.completionReason', gap.context), null);
    const repaired = searchPage([{id:'repaired',date:'2026-09-05T01:00:00Z'}]);
    repaired.url = failed.url;
    const retry = createSearchHarness([failed, repaired]);
    await vm.runInContext('_fetchPostsByDateRangeLoop()', retry.context);
    assert.deepEqual(retry.getSavedBatches().flat().map(row => row.id), ['repaired']);
}


async function testSearchDiagnosesTabAndBridgeFailures() {
    for(const [kind,expected] of [['closed','SEARCH_TAB_UNAVAILABLE'],['changed','SEARCH_PAGE_CHANGED'],['bridge','SEARCH_BRIDGE_UNAVAILABLE']]) {
        const harness=createWorkerHarness();
        harness.context.__kind=kind;
        await vm.runInContext(`
            currentExport={running:true,tweetCount:0};
            searchCapture={tabId:42,rawQuery:'(from:test)',queue:[]};
            sendSearchCaptureStatus=async()=>true;
            waitForSearchCapturePayload=async()=>null;
            chrome.tabs.get=async()=>{if(__kind==='closed')throw new Error('closed');return {status:'complete',url:__kind==='changed'?'https://x.com/home':buildSearchTimelinePageUrl('(from:test)')};};
            chrome.tabs.sendMessage=async()=>({ready:true,hookReady:false});
        `,harness.context);
        await assert.rejects(vm.runInContext('requestNextSearchCapturePayload()',harness.context),new RegExp(expected));
    }
    const harness=createSearchHarness([]);
    await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()',harness.context),/SEARCH_NO_RESPONSE/);
}

function testSearchCaptureRejectsOtherQueriesAndReportsTransportErrors() {
    const harness=createWorkerHarness();
    vm.runInContext("searchCapture={tabId:42,rawQuery:'(from:test)',queue:[],seenUrls:new Set()};",harness.context);
    for(const [rawQuery,product,accepted] of [['(from:other)','Latest',false],['(from:test)','Top',false],['(from:test)','Latest',true]]) {
        harness.context.__message={operationName:'SearchTimeline',status:200,bodyText:'',error:'SEARCH_NETWORK_ERROR',
            url:'https://x.com/i/api/graphql/query/SearchTimeline?variables='+encodeURIComponent(JSON.stringify({rawQuery,product}))};
        const result=vm.runInContext('handlePageGraphqlResponse(__message,{tab:{id:42}})',harness.context);
        assert.equal(result.success===true,accepted);
    }
    assert.equal(vm.runInContext('searchCapture.queue[0].error',harness.context),'SEARCH_NETWORK_ERROR');
    assert.equal(vm.runInContext('searchCapture.queue[0].requestCursor',harness.context),null);
    harness.context.__message.url='https://x.com/i/api/graphql/query/SearchTimeline?variables='+
        encodeURIComponent(JSON.stringify({rawQuery:'(from:test)',product:'Latest',cursor:'bottom'}));
    vm.runInContext('handlePageGraphqlResponse(__message,{tab:{id:42}})',harness.context);
    assert.equal(vm.runInContext('searchCapture.queue[1].requestCursor',harness.context),'bottom');
}

function testDateBoundariesUseLocalCalendarAndRejectInvalidDays() {
    const harness=createWorkerHarness();
    assert.equal(vm.runInContext("normalizeDateBoundary('2026-02-30','start')",harness.context),null);
    assert.equal(vm.runInContext("normalizeDateBoundary('invalid','start')",harness.context),null);
    const value=vm.runInContext(`({start:normalizeDateBoundary('2026-09-05','start').getTime(),end:normalizeDateBoundary('2026-09-05','end').getTime()})`,harness.context);
    assert.equal(value.start,new Date(2026,8,5,0,0,0,0).getTime());
    assert.equal(value.end,new Date(2026,8,5,23,59,59,999).getTime());
    for (const day of ['2026-03-08', '2026-11-01']) {
        harness.context.__day = day;
        const bounds = vm.runInContext(`({
            start: normalizeDateBoundary(__day, 'start').getTime(),
            end: normalizeDateBoundary(__day, 'end').getTime()
        })`, harness.context);
        assert.equal(bounds.start, new Date(day + 'T00:00:00').getTime());
        assert.equal(bounds.end, new Date(day + 'T23:59:59.999').getTime());
        if (process.env.TZ === 'America/New_York') {
            assert.equal(bounds.end - bounds.start + 1, (day.endsWith('03-08') ? 23 : 25) * 3600000);
        }
    }
    vm.runInContext(`
        currentExport = {
            username:'test', userId:'1',
            dateFrom:normalizeDateBoundary('2026-03-08','start'),
            dateTo:normalizeDateBoundary('2026-03-08','end'),
            dateSnapshotAt:Date.parse('2026-09-05T12:00:00Z')
        };
    `, harness.context);
    for (const [timestamp, allowed] of [
        ['2026-03-07T23:59:59.999', false], ['2026-03-08T00:00:00', true],
        ['2026-03-08T23:59:59.999', true], ['2026-03-09T00:00:00', false]
    ]) {
        harness.context.__row = {_author_id:'1',created_at:new Date(timestamp).toISOString()};
        assert.equal(vm.runInContext('dateExportAllowsTweet(__row)', harness.context), allowed);
    }
}

async function testLegacyDateResumeRequiresRestartWithoutChangingRows() {
    for (const schemaVersion of [undefined, 0, 999]) {
        const harness = createWorkerHarness();
        // A mistakenly allowed Resume must reach observable state changes,
        // not fail accidentally because the limiter stub lacks a method.
        vm.runInContext(`
            createRateLimiter=()=>({restoreState(){},onStatusChange(){},getState(){return {};}});
            launchExportLoop=()=>{};
        `, harness.context);
        const legacy = {
            schemaVersion, username:'test', userId:'1', exportMode:'posts',
            dateFrom:'2026-09-05T00:00:00.000Z', dateTo:'2026-09-05T23:59:59.999Z',
            running:false, status:'stopped', tweetCount:1, totalBatches:1, settings:{quantityLimit:500}
        };
        harness.setSavedState(legacy);
        harness.getSavedBatches()[0] = [{id:'old-row'}];
        const before = JSON.stringify(legacy);
        const result = await vm.runInContext('_resumeExportInner(100)', harness.context);
        assert.equal(result.error, 'DATE_EXPORT_RESTART_REQUIRED');
        assert.equal(JSON.stringify(harness.getSavedState()), before);
        assert.equal(harness.wasCleared(), false);
        assert.deepEqual(harness.getSavedBatches(), [[{id:'old-row'}]]);
        const status = await vm.runInContext('getExportStatus()', harness.context);
        assert.equal(status.canResume, false);
        assert.equal(status.resumeBlockedReason, 'DATE_EXPORT_RESTART_REQUIRED');
        assert.equal(status.tweetCount, 1, 'old rows must remain available to Download');
        assert.equal(status.status, 'stopped');
    }
    const harness = createWorkerHarness();
    assert.equal(vm.runInContext("getResumeBlockedReason({exportMode:'posts'})", harness.context), null,
        'unversioned exports without dates keep their existing Resume path');
    for (const boundary of ['dateFrom', 'dateTo']) {
        harness.context.__state = {[boundary]:'2026-09-05T00:00:00Z'};
        assert.equal(vm.runInContext('getResumeBlockedReason(__state)', harness.context), 'DATE_EXPORT_RESTART_REQUIRED');
    }
}

async function testVersionedDateResumePreservesBoundsAndSnapshot() {
    const harness = createWorkerHarness();
    vm.runInContext(`
        createRateLimiter = () => ({onStatusChange(){}, getState(){return {};}, restoreState(){}});
        launchExportLoop = () => {};
    `, harness.context);
    const result = await vm.runInContext(`_startExportInner({
        username:'test', exportMode:'posts', outputFormat:'csv', dateFrom:'2026-09-05', dateTo:'2026-09-05'
    })`, harness.context);
    assert.equal(result.success, true);
    const initial = {...harness.getSavedState(), userId:'1', running:false, status:'stopped'};
    assert.equal(initial.schemaVersion, harness.context.XPORTER_CONFIG.EXPORT_STATE_SCHEMA_VERSION);
    assert.equal(initial.dateFromCalendar, '2026-09-05');
    assert.equal(initial.dateToCalendar, '2026-09-05');
    assert.equal(initial.dateFrom, new Date('2026-09-05T00:00:00').toISOString());
    assert.equal(initial.dateTo, new Date('2026-09-05T23:59:59.999').toISOString());
    harness.setSavedState(initial);
    vm.runInContext('currentExport=null', harness.context);
    const resumed = await vm.runInContext('_resumeExportInner()', harness.context);
    assert.equal(resumed.success, true);
    assert.equal(harness.getSavedState().dateFromCalendar, '2026-09-05');
    assert.equal(harness.getSavedState().dateToCalendar, '2026-09-05');
    for (const key of ['schemaVersion','dateFrom','dateTo','dateSnapshotAt','startedAt']) {
        assert.equal(harness.getSavedState()[key], initial[key], key + ' must survive Resume unchanged');
    }
}

async function testSearchNetworkErrorsHaveBoundedCancellableRetries() {
    const networkError = {url:'same-request', status:200, bodyText:'', error:'SEARCH_NETWORK_ERROR'};
    const goodRow = {id:'saved', date:'2026-09-05T01:00:00Z'};
    const recovered = createSearchHarness([networkError, {...searchPage([goodRow], 'next'),url:networkError.url},
        networkError, {...searchPage([]),url:networkError.url}]);
    await vm.runInContext('_fetchPostsByDateRangeLoop()', recovered.context);
    assert.equal(recovered.getSavedState().completionReason, 'source_exhausted');
    assert.equal(recovered.getSavedState().tweetCount, 1, 'a valid page resets the consecutive-failure budget');

    const failed = createSearchHarness([searchPage([goodRow], 'next'), networkError, networkError, searchPage([])]);
    failed.context.XPORTER_CONFIG.SEARCH_CAPTURE.maxConsecutiveFailures = 2;
    failed.context.XPORTER_CONFIG.SEARCH_CAPTURE.retryDelayMs = 17;
    const waits = [];
    failed.context.__recordWait = duration => waits.push(duration);
    vm.runInContext('swSleep=async duration=>__recordWait(duration)', failed.context);
    await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()', failed.context), /SEARCH_NETWORK_ERROR/);
    assert.deepEqual(waits, [17], 'configured budget means one retry, not an unbounded loop');
    assert.equal(failed.context.__pages.length, 1);
    assert.equal(failed.getSavedState().tweetCount, 1);
    assert.equal(failed.getSavedState().completionReason, null);

    const stopped = createSearchHarness([networkError, searchPage([goodRow])]);
    vm.runInContext('swSleep=async()=>{currentExport.running=false;}', stopped.context);
    await vm.runInContext('_fetchPostsByDateRangeLoop()', stopped.context);
    assert.equal(stopped.context.__pages.length, 1, 'Stop during retry must not request another page');
    assert.equal(vm.runInContext('currentExport.completionReason', stopped.context), null);
}

async function testSearchCompletionRequiresExplicitTerminalEvidence() {
    const cases = JSON.parse(source('scripts/fixtures/search-endings.synthetic.json'));
    for (const fixture of cases) {
        const payload = {url:'fixture', status:200, bodyText:JSON.stringify({data:{
            search_by_raw_query:{search_timeline:{timeline:{instructions:fixture.instructions}}}
        }})};
        const harness = createSearchHarness([payload]);
        if (fixture.exhausted) {
            await vm.runInContext('_fetchPostsByDateRangeLoop()', harness.context);
            assert.equal(harness.getSavedState().completionReason, 'no_matches', fixture.name);
        } else {
            await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()', harness.context),
                new RegExp(fixture.error || 'SEARCH_END_UNCONFIRMED'), fixture.name);
            assert.equal(vm.runInContext('currentExport.completionReason', harness.context), null, fixture.name);
        }
    }
    const payload = searchPage([{id:'partial', date:'2026-09-05T01:00:00Z'}]);
    const data = JSON.parse(payload.bodyText);
    data.data.search_by_raw_query.search_timeline.timeline.instructions.pop();
    payload.bodyText = JSON.stringify(data);
    const harness = createSearchHarness([payload]);
    await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()', harness.context), /SEARCH_END_UNCONFIRMED/);
    assert.equal(harness.getSavedState().tweetCount, 1, 'ambiguous ending must preserve accepted rows');
}

async function testDelayedOverlayNeverReplaysAnOlderPhase() {
    const harness = createWorkerHarness();
    const timers = [];
    const phases = [];
    harness.context.setTimeout = fn => {timers.push(fn); return timers.length;};
    harness.context.__phase = phase => phases.push(phase);
    await vm.runInContext(`
        currentExport={running:true,searchPhase:'loading'};
        sendSearchCaptureStatus=async status=>__phase(status.phaseKey);
        openSearchCaptureTab('(from:test)');
    `, harness.context);
    vm.runInContext("currentExport.searchPhase='collecting'", harness.context);
    timers.shift()();
    assert.deepEqual(phases, ['collecting']);
    await vm.runInContext("openSearchCaptureTab('(from:test)')", harness.context);
    vm.runInContext("lastTransientStatus={status:'cooldown'}", harness.context);
    timers.shift()();
    assert.deepEqual(phases, ['collecting'], 'initial overlay must not replace an active rate-limit countdown');

    const retry = createWorkerHarness();
    const retryTimers = [];
    const messages = [];
    retry.context.setTimeout = fn => {retryTimers.push(fn); return retryTimers.length;};
    retry.context.chrome.tabs.sendMessage = async (_id, message) => {
        messages.push(message.phase);
        if (messages.length === 1) throw new Error('content not ready');
        return {};
    };
    vm.runInContext(`
        currentExport={running:true,username:'test',settings:{},tweetCount:0};
        searchCapture={tabId:42};
        getOverlayI18n=async()=>({searchLoading:'loading', searchWaiting:'waiting'});
    `, retry.context);
    const old = vm.runInContext("sendSearchCaptureStatus({phaseKey:'loading'}, 3)", retry.context);
    for (let i=0; i<10 && !retryTimers.length; i++) await Promise.resolve();
    assert.equal(retryTimers.length, 1);
    await vm.runInContext("sendSearchCaptureStatus({phaseKey:'waiting'})", retry.context);
    retryTimers.shift()();
    assert.equal(await old, false);
    assert.deepEqual(messages, ['loading','waiting'], 'failed older delivery must not retry after a new phase');
}

function testCalendarBoundariesAgainstIndependentUtcOracles() {
    const fixtures = JSON.parse(source('scripts/fixtures/calendar-boundaries.json'));
    // Run each timezone in its own process; changing TZ mid-process is not a
    // faithful browser update/restart and can contaminate another test.
    const script = `
        const assert = require('node:assert/strict');
        const vm = require('node:vm');
        const {createWorkerHarness} = require(process.argv[1]);
        const context = createWorkerHarness().context;
        for (const [day, expectedStart, expectedEnd] of JSON.parse(process.argv[2])) {
            context.__day = day;
            assert.equal(vm.runInContext("normalizeDateBoundary(__day,'start').toISOString()", context), expectedStart);
            assert.equal(vm.runInContext("normalizeDateBoundary(__day,'end').toISOString()", context), expectedEnd);
        }
    `;
    for (const [timezone, cases] of Object.entries(fixtures)) {
        execFileSync(process.execPath, ['-e', script, require.resolve('./worker-harness.js'), JSON.stringify(cases)], {
            env:{...process.env, TZ:timezone}, encoding:'utf8', timeout:5000
        });
    }
}

async function testDateLifecyclePersistsItsActualOutcome() {
    const row = {id:'saved', date:'2026-09-05T01:00:00Z'};
    for (const scenario of [
        {pages:[searchPage([row])], status:'complete', reason:'source_exhausted', count:1},
        {pages:[searchPage([])], status:'complete', reason:'no_matches', count:0},
        {pages:[searchPage([row], 'next')], status:'error', error:'SEARCH_STALLED', count:1},
        {pages:[{status:200, url:'bad', bodyText:'{}'}], status:'error', error:'SEARCH_INVALID_RESPONSE', count:0}
    ]) {
        const harness = createSearchHarness(scenario.pages);
        const events = [];
        harness.context.chrome.runtime.sendMessage = async message => {
            if (message.type === 'EXPORT_STATUS_UPDATE') events.push({...message});
        };
        await vm.runInContext("launchExportLoop('test date lifecycle'); exportLoopPromise", harness.context);
        const saved = harness.getSavedState();
        assert.equal(saved.status, scenario.status);
        assert.equal(saved.running, false);
        assert.equal(saved.error || null, scenario.error || null);
        assert.equal(saved.completionReason, scenario.reason || null);
        assert.equal(saved.tweetCount, scenario.count);
        assert.equal(events.at(-1).status, scenario.status);
        if (scenario.error) assert(!events.some(event => event.status === 'complete'));
        const status = await vm.runInContext('currentExport=null; getExportStatus()', harness.context);
        assert.equal(status.status, scenario.status, 'popup reopen must show the persisted outcome');
        assert.equal(status.canResume, scenario.status === 'error');
    }

    const stopped = createSearchHarness([searchPage([row], 'next')]);
    let unblockNextPage;
    let signalWaiting;
    const waiting = new Promise(resolve => { signalWaiting = resolve; });
    stopped.context.__waitForPage = () => new Promise(resolve => {
        unblockNextPage = resolve;
        signalWaiting();
    });
    stopped.context.__close = () => unblockNextPage?.(null);
    vm.runInContext(`
        requestNextSearchCapturePayload=__waitForPage;
        closeSearchCaptureTab=async()=>__close();
        rateLimiter.abort=function(){this._aborted=true;};
        launchExportLoop('test Stop during response wait');
    `, stopped.context);
    await waiting;
    await vm.runInContext('stopExport()', stopped.context);
    assert.equal(stopped.getSavedState().status, 'stopped');
    assert.equal(stopped.getSavedState().tweetCount, 1);
    assert.equal(stopped.getSavedState().completionReason, null);
}

async function testSearchRestoresVerifiedAuthorFields() {
    const page=searchPage([{id:'target',date:'2026-09-05T01:00:00Z'},
        {id:'foreign',date:'2026-09-05T01:00:00Z',authorId:'2'}]);
    const body=JSON.parse(page.bodyText);
    for(const entry of body.data.search_by_raw_query.search_timeline.timeline.instructions[0].entries) {
        delete entry.content.itemContent.tweet_results.result.core.user_results.result.core;
    }
    page.bodyText=JSON.stringify(body);
    const harness=createSearchHarness([page]);
    vm.runInContext("currentExport.userInfo={name:'Target Name',screenName:'test'}",harness.context);
    await vm.runInContext('_fetchPostsByDateRangeLoop()',harness.context);
    const rows=harness.getSavedBatches().flat();
    assert.equal(rows.length,1);
    assert.equal(rows[0].author_name,'Target Name');
    assert.equal(rows[0].author_username,'test');
}

async function testSearchCapturedCursorOnlyEnding() {
    const data=JSON.parse(source('scripts/fixtures/search-empty.live.json'));
    const payload={url:'empty',status:200,bodyText:JSON.stringify(data)};
    const empty=createSearchHarness([payload]);
    await vm.runInContext('_fetchPostsByDateRangeLoop()',empty.context);
    assert.equal(empty.getSavedState().completionReason,'no_matches');
    const nonempty=JSON.parse(searchPage([{id:'row',date:'2026-09-05T01:00:00Z'}]).bodyText);
    nonempty.data.search_by_raw_query.search_timeline.timeline.instructions.pop();
    nonempty.data.search_by_raw_query.search_timeline.timeline.instructions[0].entries.push(
        ...data.data.search_by_raw_query.search_timeline.timeline.instructions[0].entries);
    const page=createSearchHarness([{url:'first',status:200,bodyText:JSON.stringify(nonempty)},payload]);
    await vm.runInContext('_fetchPostsByDateRangeLoop()',page.context);
    assert.equal(page.context.__pages.length,0,'a bottom-0 cursor with rows is not terminal');
    assert.equal(page.getSavedState().tweetCount,1);
    assert.equal(page.getSavedState().completionReason,'source_exhausted');
    const ambiguous=JSON.parse(payload.bodyText);
    delete ambiguous.data.search_by_raw_query.search_timeline.timeline.instructions[0].entries[0].content.cursorType;
    const invalid=createSearchHarness([{...payload,bodyText:JSON.stringify(ambiguous)}]);
    await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()',invalid.context),/SEARCH_STALLED/);
}

async function testOverlayRetainsSelectedCalendarLabels() {
    const harness=createWorkerHarness();
    const messages=[];
    harness.context.chrome.tabs.sendMessage=async(_id,message)=>{messages.push(message);return {};};
    vm.runInContext(`
        currentExport={running:true,username:'test',settings:{},tweetCount:0,
            dateFrom:new Date('2026-09-03T10:00:00Z'),dateTo:new Date('2026-09-04T09:59:59Z'),
            dateFromCalendar:'2026-09-04',dateToCalendar:'2026-09-04'};
        searchCapture={tabId:42}; getOverlayI18n=async()=>({});
    `,harness.context);
    await vm.runInContext('sendSearchCaptureStatus()',harness.context);
    assert.equal(messages[0].dateFrom,'2026-09-04');
    assert.equal(messages[0].dateTo,'2026-09-04');
}

async function testBottomPaginationIgnoresTopEmptyResponse() {
    const ending={url:'bottom-page',status:200,requestCursor:'bottom',
        bodyText:source('scripts/fixtures/search-empty-pagination.live.json')};
    const first={...searchPage([{id:'first',date:'2026-09-05T01:00:00Z'}],'bottom'),requestCursor:null};
    const harness=createSearchHarness([first, {...ending,url:'top-page',requestCursor:'top'}, ending]);
    await vm.runInContext('_fetchPostsByDateRangeLoop()',harness.context);
    assert.equal(harness.context.__pages.length,0,'a top response must not terminate downward pagination');
    assert.equal(harness.getSavedState().completionReason,'source_exhausted');
    assert.equal(harness.getSavedState().tweetCount,1);
}

const tests = [
    { name: "bottom pagination ignores top empty response", run: testBottomPaginationIgnoresTopEmptyResponse, order: 98 },
    { name: "overlay retains selected calendar labels", run: testOverlayRetainsSelectedCalendarLabels, order: 97 },
    { name: "search captured cursor-only ending", run: testSearchCapturedCursorOnlyEnding, order: 96 },
    { name: "search restores verified author fields", run: testSearchRestoresVerifiedAuthorFields, order: 95 },
    { name: "search retry cannot skip failed page", run: testSearchRetryCannotSkipFailedPage, order: 94 },
    { name: "calendar bounds match independent UTC instants", run: testCalendarBoundariesAgainstIndependentUtcOracles, order: 92 },
    { name: "date lifecycle persists real terminal outcomes", run: testDateLifecyclePersistsItsActualOutcome, order: 93 },
    { name: "legacy date Resume is explicit and nondestructive", run: testLegacyDateResumeRequiresRestartWithoutChangingRows, order: 87 },
    { name: "versioned date Resume preserves exact snapshot", run: testVersionedDateResumePreservesBoundsAndSnapshot, order: 88 },
    { name: "search network retry budget and Stop", run: testSearchNetworkErrorsHaveBoundedCancellableRetries, order: 89 },
    { name: "search endings require explicit evidence", run: testSearchCompletionRequiresExplicitTerminalEvidence, order: 90 },
    { name: "overlay timers cannot replay stale phases", run: testDelayedOverlayNeverReplaysAnOlderPhase, order: 91 },
    { name: "search errors never become empty success", run: testSearchErrorsNeverBecomeEmptySuccess, order: 78 },
    { name: "today exact boundaries and snapshot", run: testSearchTodayIncludesExactBoundsAndFreezesNow, order: 79 },
    { name: "search silence never means date coverage", run: testSearchSilenceNeverUsesDateCoverage, order: 80 },
    { name: "search empty limit and stop reasons", run: testSearchEmptyLimitAndStopReasons, order: 81 },
    { name: "search resume dedup and malformed retry", run: testSearchResumeDedupAndFailureRecovery, order: 82 },
    { name: "search tab and bridge diagnosis", run: testSearchDiagnosesTabAndBridgeFailures, order: 84 },
    { name: "search query identity and transport errors", run: testSearchCaptureRejectsOtherQueriesAndReportsTransportErrors, order: 85 },
    { name: "local calendar and invalid dates", run: testDateBoundariesUseLocalCalendarAndRejectInvalidDays, order: 86 },
];

module.exports = { id: 'date-export', tests };
