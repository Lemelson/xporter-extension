/** XPorter collector v2. Container-bound to the UninstallsXPorter workbook.
 * Deploy by editing the EXISTING web-app deployment, choosing a new version.
 * setupTelemetrySchema() only creates documentation; it never migrates Sheet1.
 * Run configureBoundSpreadsheet() once from the bound editor before deployment.
 * Web requests open the private SPREADSHEET_ID Script Property; web apps have
 * no active spreadsheet. The ID is never stored in source control or responses.
 */
var COLLECTOR_VERSION = 2;
var SERVICE_NAME = 'xporter-feedback';
// Only what docs/feedback.html actually sends; anything else is rejected.
var SOURCES = ['uninstall','direct'];
var EVENT_TYPES = ['open','reason','reason_update','detail'];
var SCHEMA_VERSIONS = [1,2];
// detail = page chip summary (up to ~1.1k chars) + textarea (maxlength 2000).
var LIMITS = {payload:64000, detail:4000, list:4000, text:200, stat:128};
// Abuse limits. The page writes once per chip/reason click and on every hide,
// so the per-session budget leaves room for a genuinely indecisive visitor.
var RATE = {sessionWrites:40, sessionWindowS:600, newSessionsPerHour:300, seenTtlS:21600};
// Always stored as plain text: identifiers and free text must never be parsed.
var TEXT_COLUMNS = ['sessionId','source','reason','detail','pageLang','lastType','ua','src','detail_receipt',
  'subreasons','subreason_labels','reason_history','subreasons_all','subreason_labels_all','language_source'];
var BASE_COLUMNS = ['received','sessionId','source','reason','detail','pageLang','lastType','clientTs','updated','ua'];
var STAT_FIELDS = ['schema_version','v','os','days','installed_at','ui_lang','theme','opens','active_s',
  'exp_started','exp_ok','exp_err','exp_stopped','m_posts','m_followers','m_following','m_verified','m_dates',
  'resumes','dl','f_csv','f_json','f_xlsx','items','last_days','last_err','last_phase','first_item_ms',
  's_retweets','s_replies','s_articles','s_limit','s_localize','s_speed','s_adaptive','inst_approx','s_safety',
  'm_bookmarks','install_v','schema_since','snapshot_at','install_id','browser_family','browser_major',
  's_user_speed','s_user_safety','diag_historical','diag_active_days','diag_first_attempt_ms','diag_first_start_ms',
  'diag_first_item_ms','diag_first_download_ms','diag_attempts','diag_downloads','diag_totals',
  'transport_omitted_attempts','transport_omitted_downloads','diag_revision','consent_version','transport_summary_only',
        's_colorful', 's_ladybug', 's_window_width', 's_window_height', 's_element_size', 's_text_size', 's_auto_expire', 's_auto_expire_hours', 's_mode', 's_format', 's_originals', 's_quotes', 's_bookmark_context', 's_bookmark_articles', 's_post_photos', 's_bookmark_photos', 's_about', 's_about_speed', 's_about_batch', 's_about_retries', 'f_txt', 'ladybug_squashes', 'theme_preset',
  'ui_diag_version', 'ui_diag_since', 'ui_start_clicks', 'ui_start_sent', 'ui_start_accepted', 'ui_start_invalid', 'ui_start_worker_error', 'ui_no_session_views', 'ui_status_read_errors', 'ui_theme_changes', 'ui_speed_changes', 'ui_settings_views', 'ui_about_views', 'f_pdf'];
var FORM_FIELDS = ['src','page_s','subreasons','subreason_labels','reason_history','subreasons_all',
  'subreason_labels_all','transport_error','form_version','language_source','page_opened_at'];
var ATTEMPT_FIELDS = ['id','at','version','mode','format','resume','dateRange','settings','phase','result',
  'startedAt','firstItemMs','durationMs','rows','error','completion','requests','rateLimits','retries',
  'timeouts','networkErrors','pauses','pauseMs'];
var DOWNLOAD_FIELDS = ['id','at','mode','format','source','rows','parts','handedOff','completedParts','bytes',
  'generationMs','result','error','photosEnabled','photoPermission','photosAttempted','photosLoaded','photosFailed'];
var TOTAL_FIELDS = ['attempts','started','complete','stopped','error','rejected','interrupted','downloadStarted',
  'downloadComplete','downloadInterrupted','downloadFailed','clipboard','requests','rateLimits','retries',
  'timeouts','networkErrors','pauses','pauseMs','downloadUnknown'];
var SETTING_FIELDS = ['includeOriginalPosts','includeQuotes','includeReplies','includeRetweets','includeArticles',
  'includeBookmarkReplyContext','includeBookmarkArticles','embedPostPhotos','embedBookmarkPhotos',
  'includeAboutAccountDetails','adaptivePacing','localizeExportHeaders','postSafetyBreakEnabled',
  'userSafetyBreakEnabled','quantityLimit','customDelaySec','userCustomDelaySec','postSafetyBreakEvery',
  'postSafetyBreakMin','userSafetyBreakEvery','userSafetyBreakMin','aboutAccountCustomBatchSize',
  'aboutAccountMaxRetries','exportSpeed','userExportSpeed','aboutAccountSpeed'];
var REASONS = ['r_broken','r_confusing','r_slow','r_missing','r_once','r_alt','r_privacy','r_other'];

function getBoundSpreadsheet() {
  var expected = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!expected) throw new Error('Configure the bound spreadsheet before deployment');
  var book = SpreadsheetApp.openById(expected);
  if (!book || book.getId() !== expected) throw new Error('Configured spreadsheet mismatch; no data written');
  return book;
}
// Editor-only initialization; never called from public doGet/doPost endpoints.
function configureBoundSpreadsheet() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error('Run from the bound spreadsheet editor');
  var properties = PropertiesService.getScriptProperties();
  var expected = properties.getProperty('SPREADSHEET_ID');
  if (expected && expected !== book.getId()) throw new Error('Configured spreadsheet mismatch; unchanged');
  properties.setProperty('SPREADSHEET_ID', book.getId());
  return health();
}
function nowIso() { return Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'"); }
function json(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function health() { return {ok:true,service:SERVICE_NAME,collector_version:COLLECTOR_VERSION,time:nowIso()}; }
// Sheets evaluates =, +, - and @ (also after leading whitespace/tab/CR) as a
// formula. A leading apostrophe forces text and is not part of the stored value.
function escapeFormula(text) { return /^\s*[=+@-]/.test(text) ? "'" + text : text; }
function textCell(value, limit) {
  return escapeFormula(String(value === undefined || value === null ? '' : value).slice(0, limit || LIMITS.stat));
}
function primitive(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return isFinite(value) ? Math.max(0, Math.min(1e12, value)) : null;
  return typeof value === 'string' ? value.slice(0, 128) : null;
}
function cleanRecord(value, keys) {
  var result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  keys.forEach(function(key) {
    if (key === 'settings') result[key] = cleanRecord(value[key], SETTING_FIELDS);
    else if (Object.prototype.hasOwnProperty.call(value,key)) result[key] = primitive(value[key]);
  });
  return result;
}
// New preference columns accept only their documented primitive values.
var CURRENT_BOOL_FIELDS = ['s_colorful','s_ladybug','s_auto_expire','s_originals','s_quotes',
  's_bookmark_context','s_bookmark_articles','s_post_photos','s_bookmark_photos','s_about'];
var CURRENT_NUMBER_FIELDS = {
  s_window_width:[80,150,5],s_window_height:[50,100,5],s_element_size:[80,130,5],s_text_size:[80,130,5],
  s_auto_expire_hours:[1,48,1],s_about_batch:[1,50,1],s_about_retries:[1,1440,1],f_txt:[0,1e12,1],f_pdf:[0,1e12,1],ladybug_squashes:[0,1e12,1]
};
var CURRENT_CHOICE_FIELDS = {
  theme_preset:['classic-dark', 'classic-light', 'glass-dark', 'glass-light', 'obsidian', 'signal', 'cobalt', 'forest', 'bordeaux', 'porcelain', 'iris'],
  s_mode:['posts','bookmarks','followers','following','verified_followers','seen_posts'],
  s_format:['csv','json','xlsx','txt','pdf'],s_about_speed:['turbo','fast','standard','careful','turtle','custom']
};
var UI_COUNTER_FIELDS = ['ui_start_clicks','ui_start_sent','ui_start_accepted','ui_start_invalid','ui_start_worker_error',
  'ui_no_session_views','ui_status_read_errors','ui_theme_changes','ui_speed_changes','ui_settings_views','ui_about_views'];
function cleanStat(key, value) {
  if (key === 'ui_diag_version') return value === 1 ? 1 : '';
  if (key === 'ui_diag_since') return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : '';
  if (UI_COUNTER_FIELDS.indexOf(key)>=0) return typeof value === 'number' && Number.isSafeInteger(value) && value>=0 && value<=1e12 ? value : '';
  if (CURRENT_BOOL_FIELDS.indexOf(key)>=0) return value===0 || value===1 ? value : '';
  if (Object.prototype.hasOwnProperty.call(CURRENT_NUMBER_FIELDS,key)) {
    var range=CURRENT_NUMBER_FIELDS[key];
    return typeof value==='number' && Number.isFinite(value) && value>=range[0] && value<=range[1] && value%range[2]===0 ? value : '';
  }
  if (Object.prototype.hasOwnProperty.call(CURRENT_CHOICE_FIELDS,key)) return CURRENT_CHOICE_FIELDS[key].indexOf(value)>=0 ? value : '';
  if (key === 'diag_attempts' || key === 'diag_downloads') {
    if (!Array.isArray(value)) return '';
    return JSON.stringify(value.slice(-5).map(function(row) {
      return cleanRecord(row, key === 'diag_attempts' ? ATTEMPT_FIELDS : DOWNLOAD_FIELDS);
    }));
  }
  if (key === 'diag_totals') return JSON.stringify(cleanRecord(value, TOTAL_FIELDS));
  if (typeof value === 'number') return primitive(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return textCell(value, /labels|subreasons|reason_history/.test(key) ? LIMITS.list : LIMITS.stat);
}
function getHeaders(sheet) {
  return sheet.getLastRow() ? sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0] : [];
}
function ensureColumns(sheet, keys) {
  var headers = getHeaders(sheet);
  var missing = keys.filter(function(key) { return headers.indexOf(key) < 0; });
  if (missing.length) sheet.getRange(1,headers.length+1,1,missing.length).setValues([missing]);
}
function findRowBySession(sheet, headers, id) {
  var column = headers.indexOf('sessionId') + 1;
  if (!column || sheet.getLastRow() < 2) return -1;
  var rows = sheet.getRange(2,column,sheet.getLastRow()-1,1).getValues();
  for (var i=rows.length-1;i>=0;i--) if (String(rows[i][0]) === id) return i+2;
  return -1;
}
function flatten(payload, now) {
  var stats = payload.stats || {};
  var flat = {received:now,first_received:now,sessionId:payload.sessionId,source:payload.source,
    reason:REASONS.indexOf(payload.reason) >= 0 ? payload.reason : '',detail:textCell(payload.detail,LIMITS.detail),
    pageLang:textCell(payload.pageLang,16),lastType:EVENT_TYPES.indexOf(payload.type)>=0 ? payload.type : '',
    clientTs:textCell(payload.ts,32),updated:now,ua:'',collector_version:COLLECTOR_VERSION,
    schema_version:Number(stats.schema_version) === 2 ? 2 : 1};
  STAT_FIELDS.concat(FORM_FIELDS).forEach(function(key) {
    if (key !== 'schema_version' && Object.prototype.hasOwnProperty.call(stats,key)) flat[key]=cleanStat(key,stats[key]);
  });
  flat.src = payload.source;
  if (Number.isFinite(payload.feedback_seq)) flat.feedback_seq = Math.max(0,Math.min(1e6,Math.floor(payload.feedback_seq)));
  if (payload.type === 'detail' && /^[A-Za-z0-9_-]{10,80}$/.test(payload.receipt_id || '')) flat.detail_receipt=payload.receipt_id;
  if (flat.diag_totals) {
    var totals=JSON.parse(flat.diag_totals);
    TOTAL_FIELDS.forEach(function(key) { if (totals[key] !== undefined) flat['d_'+key]=totals[key]; });
  }
  [['diag_attempts','last_attempt_'],['diag_downloads','last_download_']].forEach(function(pair) {
    var rows=flat[pair[0]] ? JSON.parse(flat[pair[0]]) : [];
    var row=rows[rows.length-1];
    if (row) Object.keys(row).forEach(function(key) {
      flat[pair[1]+key]=row[key] && typeof row[key] === 'object' ? JSON.stringify(row[key])
        : typeof row[key] === 'string' ? textCell(row[key]) : row[key];
    });
  });
  var installed=Date.parse(stats.installed_at || '');
  if (installed && payload.source === 'uninstall') flat.lived_min=Math.max(0,Math.round((Date.parse(now)-installed)/60000));
  return flat;
}
function mergeRow(headers, previous, flat) {
  var old=Object.fromEntries(headers.map(function(key,i) {return [key,previous[i]];}));
  var hasFeedback=flat.reason || flat.lastType === 'detail' || flat.subreasons !== undefined;
  var incomingSequence=Number(flat.feedback_seq);
  var oldSequence=Number(old.feedback_seq);
  var freshFeedback=hasFeedback && (!Number.isFinite(incomingSequence) || old.feedback_seq === '' || old.feedback_seq === undefined || incomingSequence >= oldSequence);
  var feedbackFields=['reason','detail','subreasons','subreason_labels','reason_history','subreasons_all','subreason_labels_all','feedback_seq','detail_receipt'];
  var ranks={open:1,reason:2,reason_update:2,detail:3};
  var incomingSnapshot=Date.parse(flat.snapshot_at), oldSnapshot=Date.parse(old.snapshot_at);
  var olderSnapshot=Number.isFinite(incomingSnapshot) && Number.isFinite(oldSnapshot) && incomingSnapshot<oldSnapshot;
  var olderRevision=flat.diag_revision !== undefined && old.diag_revision !== '' && old.diag_revision !== undefined
    && Number(flat.diag_revision)<Number(old.diag_revision);
  return headers.map(function(key,i) {
    var incoming=flat[key]; var prior=previous[i] === undefined ? '' : previous[i];
    // Never reinterpret a legacy row, or claim a newly observed first timestamp
    // for a session that was already present before this collector was deployed.
    if (['received','first_received','lived_min','schema_version','collector_version','installed_at','schema_since'].indexOf(key)>=0) return prior;
    if (key === 'lastType') return freshFeedback && (ranks[incoming]||0)>=(ranks[prior]||0) ? incoming : prior;
    if (feedbackFields.indexOf(key)>=0 && !freshFeedback) return prior;
    // Explicit Send replaces the submitted comment, including a deliberate
    // empty value after Back. Passive dwell/reason events retain the comment.
    if (key === 'detail' && flat.lastType === 'detail') return incoming;
    if (key === 'page_s') return Math.max(Number(prior)||0,Number(incoming)||0);
    // The URL is one snapshot: do not combine its older preferences, counters
    // or expanded diagnostic records with a newer revision already stored.
    // Feedback fields and page dwell are independently ordered above.
    if ((olderSnapshot || olderRevision) && (STAT_FIELDS.indexOf(key)>=0 || /^d_|^last_attempt_|^last_download_/.test(key))) return prior;
    return incoming !== undefined && incoming !== null && incoming !== '' ? incoming : prior;
  });
}
// Validate before any lock or Sheet access. Returns a sanitized payload that
// carries only the fields the feedback page sends; unknown keys are dropped.
function parseRequest(e) {
  var raw=e && e.postData && e.postData.contents || '';
  if (raw.length>LIMITS.payload) throw new Error('too_large');
  var body=JSON.parse(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
  if (!/^[A-Za-z0-9:_.-]{1,160}$/.test(body.sessionId || '')) throw new Error('invalid');
  if (SOURCES.indexOf(body.source)<0) throw new Error('invalid');
  if (body.type !== undefined && EVENT_TYPES.indexOf(body.type)<0) throw new Error('invalid');
  if (body.test !== undefined && typeof body.test !== 'boolean') throw new Error('invalid');
  var stats=body.stats === undefined ? {} : body.stats;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) throw new Error('invalid');
  var schema=stats.schema_version;
  if (schema !== undefined && schema !== '' && SCHEMA_VERSIONS.indexOf(Number(schema))<0) throw new Error('invalid');
  return {sessionId:body.sessionId,source:body.source,type:body.type,test:body.test === true,
    reason:typeof body.reason === 'string' ? body.reason.slice(0,LIMITS.text) : '',
    detail:typeof body.detail === 'string' ? body.detail.slice(0,LIMITS.detail) : '',
    pageLang:typeof body.pageLang === 'string' ? body.pageLang.slice(0,LIMITS.text) : '',
    ts:typeof body.ts === 'string' ? body.ts.slice(0,LIMITS.text) : '',
    receipt_id:typeof body.receipt_id === 'string' ? body.receipt_id.slice(0,LIMITS.text) : '',
    feedback_seq:body.feedback_seq,stats:stats};
}
// CacheService counters are approximate (no atomic increment) but need no lock:
// a flood is refused before it can queue on the ScriptLock.
function rateLimit(sessionId) {
  try {
    var cache=CacheService.getScriptCache(), now=Date.now();
    var sessionKey='w:'+Math.floor(now/(RATE.sessionWindowS*1000))+':'+sessionId;
    var writes=Number(cache.get(sessionKey)) || 0;
    if (writes>=RATE.sessionWrites) return 'rate_limited';
    var seenKey='s:'+sessionId;
    if (!cache.get(seenKey)) {
      var hourKey='n:'+Math.floor(now/3600000);
      var created=Number(cache.get(hourKey)) || 0;
      if (created>=RATE.newSessionsPerHour) return 'busy';
      cache.put(hourKey,String(created+1),3600);
      cache.put(seenKey,'1',RATE.seenTtlS);
    }
    cache.put(sessionKey,String(writes+1),RATE.sessionWindowS);
  } catch (error) {console.error('xporter-feedback cache unavailable',error);}
  return '';
}
function columnName(column) {
  var name='';
  for (;column>0;column=Math.floor((column-1)/26)) name=String.fromCharCode(65+(column-1)%26)+name;
  return name;
}
// Stored text must stay text on every write, including rewrites of values read
// back with getValues() (which drops the protective apostrophe). Numbers and
// server/ISO timestamps keep their default format so analysis stays numeric.
function needsTextFormat(key, value) {
  if (typeof value !== 'string' || value === '') return false;
  if (TEXT_COLUMNS.indexOf(key)>=0) return true;
  return !/^\d+(\.\d+)?$/.test(value) && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value);
}
function writeRow(sheet, row, headers, values) {
  var safe=values.map(function(value) {
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? escapeFormula(value) : value;
  });
  var textCells=[];
  safe.forEach(function(value,i) {if (needsTextFormat(headers[i],value)) textCells.push(columnName(i+1)+row);});
  if (textCells.length) sheet.getRangeList(textCells).setNumberFormat('@');
  sheet.getRange(row,1,1,safe.length).setValues([safe]);
}
function doPost(e) {
  var payload;
  try {payload=parseRequest(e);}
  catch (error) {
    console.error('xporter-feedback rejected request',error);
    return json({ok:false,error:error && error.message === 'too_large' ? 'too_large' : 'invalid'});
  }
  var limited=rateLimit(payload.sessionId);
  if (limited) return json({ok:false,error:limited});
  var flat=flatten(payload,nowIso());
  var lock=LockService.getScriptLock();
  if (!lock.tryLock(5000)) return json({ok:false,error:'busy'});
  try {
    var book=getBoundSpreadsheet();
    var sheetName=payload.test ? 'TelemetryTests' : 'Sheet1';
    var sheet=book.getSheetByName(sheetName) || book.insertSheet(sheetName);
    if (!sheet.getLastRow()) {sheet.appendRow(BASE_COLUMNS);sheet.setFrozenRows(1);}
    ensureColumns(sheet,Object.keys(flat));
    var headers=getHeaders(sheet);
    var index=findRowBySession(sheet,headers,payload.sessionId);
    if (index>0) {
      var previous=sheet.getRange(index,1,1,headers.length).getValues()[0];
      writeRow(sheet,index,headers,mergeRow(headers,previous,flat));
    } else writeRow(sheet,sheet.getLastRow()+1,headers,headers.map(function(key) {return flat[key];}));
    return json({ok:true,collector_version:COLLECTOR_VERSION});
  } catch (error) {
    console.error('xporter-feedback write failed',error);
    return json({ok:false,error:'unavailable'});
  } finally {lock.releaseLock();}
}
function doGet(e) {
  if (e && e.parameter && e.parameter.callback) {
    var callback=e.parameter.callback;
    if (!/^xpReceipt_[a-z0-9]+$/.test(callback)) return json({ok:false});
    var receipt=findReceipt(e.parameter.sessionId,e.parameter.receipt_id,e.parameter.test === '1');
    return ContentService.createTextOutput(callback+'('+JSON.stringify(receipt)+');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  try {getBoundSpreadsheet(); return json(health());}
  catch (error) {console.error('xporter-feedback health failed',error); return json({ok:false,error:'unavailable'});}
}
// A receipt reveals only whether this unguessable token was written, never
// comments, counters, contacts or other users' records. Used after explicit Send.
function findReceipt(sessionId, token, test) {
  if (!/^[A-Za-z0-9:_.-]{1,160}$/.test(sessionId || '') || !/^[A-Za-z0-9_-]{10,80}$/.test(token || '')) return {ok:false};
  try {
    var sheet=getBoundSpreadsheet().getSheetByName(test ? 'TelemetryTests' : 'Sheet1');
    if (!sheet) return {ok:false};
    var headers=getHeaders(sheet),column=headers.indexOf('detail_receipt');
    var row=findRowBySession(sheet,headers,sessionId);
    return {ok:column>=0 && row>0 && sheet.getRange(row,column+1).getValues()[0][0] === token};
  } catch (_) {return {ok:false};}
}

function setupTelemetrySchema() {
  var lock=LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Collector busy; retry setupTelemetrySchema');
  try {
    var book=getBoundSpreadsheet();
    var sheet=book.getSheetByName('TelemetrySchema') || book.insertSheet('TelemetrySchema');
    if (!sheet.getLastRow()) {
      sheet.appendRow(['Field / Поле','Since / Версия','Meaning / Значение','Unit / Единица','Caveat / Ограничение','Documented at']);
      sheet.setFrozenRows(1);
    }
    var documented={};
    if (sheet.getLastRow()>1) sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues().forEach(function(row){documented[row[0]]=true;});
    var definitions=schemaDefinitions();
    definitions.forEach(function(row) {if (!documented[row[0]]) sheet.appendRow(row.concat([nowIso()]));});
    return health();
  } finally {lock.releaseLock();}
}
function schemaDefinitions() {
  var rows=[
    ['SCHEMA 2','2','New diagnostics are additive. Старые строки не изменены.','','Blank schema_version means legacy 1. Never fill historical missing values with zero.'],
    ['Sheet1','1/2','Uninstall and direct feedback / Удаления и прямые посещения','','Filter source=uninstall; a client-provided label is not cryptographic proof of removal.'],
    ['Usage','2','Legacy opt-in daily snapshots (no longer written) / Устаревшие снимки','','Historical only; cumulative totals, do not sum snapshots. Not all installations.'],
    ['TelemetryTests','2','Synthetic verification only / Только тестовые записи','','Exclude this entire sheet from product analysis.'],
    ['schema_version','2','Version of extension measurement semantics','','Blank or 1 = legacy; 2 = additional diagnostics since schema_since.'],
    ['collector_version','2','Collector that first created this row','','Independent of extension and form versions.'],
    ['first_received','2','Immutable server time of first event','ISO UTC','Empty for pre-existing rows; the original instant cannot be reconstructed.'],
    ['received','1/2','Legacy receipt timestamp; now preserved on update','ISO UTC','Old collector overwrote this on updates. Do not treat historical values as exact removal times.'],
    ['lived_min','1','Install to first feedback event, pinned','minutes','May include delay before opening feedback. inst_approx=1 means install date was backfilled.'],
    ['exp_started / exp_ok / exp_err / exp_stopped / items / dl','1','Original lifetime counters remain unchanged','','items counts completion deltas; dl counts handoff operations, not confirmed saved files. Resume counts as another start.'],
    ['last_err / last_phase / first_item_ms','1','Legacy last-error and last-attempt fields','','last_err can predate last_phase. first_item_ms=0 means missing first row in last run.'],
    ['schema_since','2','Start of new observation window','ISO UTC','d_* totals and first milestones cover only this window.'],
    ['diag_historical','2','Prior exports existed when schema 2 began','0/1','First milestones are first OBSERVED since schema_since, not reconstructed lifetime firsts.'],
    ['diag_attempts','2','Up to 5 recent attempts including rejected starts','JSON','Full field order documented as attempt.*; transport may omit oldest rows.'],
    ['diag_downloads','2','Up to 5 recent download operations','JSON','Confirmed complete only when every tracked file part is complete.'],
    ['diag_totals','2','Counters since schema_since','JSON','Same counters also expanded into d_* columns.'],
    ['transport_omitted_attempts','2','Recent attempts omitted to fit Chrome URL','count','Explicit loss marker; full recent history remains in optional usage snapshots/local report.'],
    ['transport_omitted_downloads','2','Recent downloads omitted to fit Chrome URL','count','Do not interpret omitted records as absent activity.'],
    ['transport_summary_only','2','URL retained only basic summary','0/1','1 means diagnostic totals were omitted too.'],
    ['transport_error','2','Compressed summary was unavailable or invalid','0/1','Missing diagnostics are unknown, never zero.'],
    ['feedback_seq','2','Order of user feedback revisions within visit','integer','Late packets cannot replace newer reason/subreason choices.'],
    ['detail_receipt','2','Random token acknowledging explicit Send','','The page checks only receipt existence before showing success.'],
    ['language_source','2','How page language was chosen','','extension, browser, manual or fallback.'],
    ['s_safety / s_user_safety','2','Scheduled pause settings for posts / user lists','minutes_requests or off','Settings snapshot at URL refresh; attempt.settings are launch-time settings.'],
    ['s_colorful / s_ladybug','2','Current colorful appearance and ladybug settings','0/1','Colorful is enabled when the legacy simplifiedDesign storage flag is true.'],
    ['s_window_width / s_window_height / s_element_size / s_text_size','2','Saved window/content slider choices','percent','Chosen percentages, not measured pixels; text slider is not the rendered font multiplier.'],
    ['s_auto_expire / s_auto_expire_hours','2','Automatic data deletion toggle and saved duration','0/1 and hours','Duration remains saved when disabled.'],
    ['ui_diag_version / ui_diag_since','UI 1','Start of local UI-funnel observation','1 and ISO UTC','Missing means unknown; counters cover only this window, not lifetime.'],
    ['ui_start_clicks / ui_start_sent / ui_start_accepted / ui_start_invalid / ui_start_worker_error','UI 1','Observed Start funnel','count','Clicks, submitted worker messages, accepted starts, validation failures and worker errors are separate stages.'],
    ['ui_no_session_views / ui_status_read_errors','UI 1','Observed unavailable session/status UI states','count','Views/events, not distinct users or installations.'],
    ['ui_theme_changes / ui_speed_changes / ui_settings_views / ui_about_views','UI 1','Observed preference interaction and tab visits','count','No change values, account identifiers or interaction timestamps are recorded.'],
    ['s_mode / s_format','2','Current saved mode and format','','May differ from last_attempt_mode/format; no export required.'],
    ['browser_family / browser_major','2','Coarse browser family and main version','','No full User-Agent. Chromium forks may report chromium/chrome.'],
    ['install_id','2','Random ID scoped to browser installation','UUID','Pseudonymous; reset on reinstall. Never a username or device fingerprint.'],
    ['diag_active_days','2','Distinct observed UI-open days since schema_since','UTC days','Activity-only; no background heartbeat on days with no UI activity.'],
    ['last_attempt_* / last_download_*','2','Expanded most recent JSON record','','Use for filtering; retain JSON for preceding attempts. Null latency means not observed.']
  ];
  var described={};rows.forEach(function(row){described[row[0]]=true;});
  STAT_FIELDS.concat(FORM_FIELDS).forEach(function(key){if(!described[key]) rows.push([key,'1/2',fieldMeaning(key),'','Legacy fields keep old semantics; diagnostic milestones are relative to schema_since.']);});
  TOTAL_FIELDS.forEach(function(key){rows.push(['d_'+key,'2','Observed '+key+' since schema_since',/Ms$/.test(key)?'ms':'count','Cumulative; do not sum repeated usage snapshots.']);});
  ATTEMPT_FIELDS.forEach(function(key){rows.push(['attempt.'+key,'2',recordMeaning(key),'','Only this attempt; settings captured at launch. Rows include available resumed rows.']);});
  DOWNLOAD_FIELDS.forEach(function(key){rows.push(['download.'+key,'2',recordMeaning(key),'','One operation can create multiple files; source identifies current/history/seen_posts.']);});
  return rows;
}
function fieldMeaning(key) {
  var labels={v:'Extension version',os:'Operating system',days:'Floored days at snapshot',installed_at:'Installation timestamp',
    ui_lang:'Extension UI language',theme:'Light or dark mode',theme_preset:'Selected theme preset ID',opens:'Lifetime UI openings',active_s:'Lifetime focused visible UI seconds',
    m_posts:'Post export starts',m_followers:'Followers export starts',m_following:'Following export starts',m_verified:'Verified followers starts',
    m_dates:'Date-range export starts',m_bookmarks:'Bookmark export starts',resumes:'Resume starts',f_csv:'CSV-selected starts',
    s_colorful:'Current Colorful appearance enabled',s_ladybug:'Current Show ladybug enabled',
    s_window_width:'Saved window width percent',s_window_height:'Saved window height percent',
    s_element_size:'Saved element size percent',s_text_size:'Saved text size percent',
    s_auto_expire:'Automatic deletion enabled',s_auto_expire_hours:'Saved automatic deletion hours',
    s_mode:'Currently selected export mode',s_format:'Currently selected output format',
    s_originals:'Current original-post filter',s_quotes:'Current quote-post filter',
    s_bookmark_context:'Current bookmark reply context',s_bookmark_articles:'Current bookmark Articles',
    s_post_photos:'Current post photo embedding',s_bookmark_photos:'Current bookmark photo embedding',
    s_about:'Current About Account details enabled',s_about_speed:'Current About Account speed',
    s_about_batch:'Current About Account custom batch',s_about_retries:'Current About Account retry limit',
    f_pdf:'PDF-selected starts (printable HTML; does not confirm a saved PDF)',ladybug_squashes:'Lifetime ladybugs squashed',f_txt:'TXT-selected starts',f_json:'JSON-selected starts',f_xlsx:'XLSX-selected starts',last_days:'Days since last terminal export event',
    s_retweets:'Include reposts',s_replies:'Include replies',s_articles:'Include Articles',s_limit:'Selected quantity limit',
    s_localize:'Localize export headers',s_speed:'Posts speed',s_user_speed:'User-list speed',s_adaptive:'Adaptive pacing',
    inst_approx:'Install timestamp is approximate',install_v:'First-install version when known',snapshot_at:'Snapshot creation time UTC',
    diag_revision:'Monotonic diagnostic revision',consent_version:'Opt-in usage consent version',
    diag_first_attempt_ms:'Time from schema_since to first observed Start attempt',diag_first_start_ms:'Time to first observed accepted Start',
    diag_first_item_ms:'Time to first observed new collected item',diag_first_download_ms:'Time to first observed fully completed download',
    src:'Legacy source alias',page_s:'Visible feedback-page seconds',form_version:'Feedback page schema version',page_opened_at:'Browser first-open time',
    subreasons:'Selected current-reason subreason codes',subreason_labels:'English display labels for current subreasons',
    reason_history:'Reasons visited, not independent removal reasons',subreasons_all:'Subreason codes retained across reason switches',
    subreason_labels_all:'English labels grouped by reason'};
  return labels[key] || key;
}
function recordMeaning(key) {
  return {id:'Local operation sequence',at:'Attempt time, Unix milliseconds',version:'Extension version at attempt',
    phase:'Last working phase before terminal outcome',result:'Terminal outcome or pending/generating/handed_off',
    firstItemMs:'Start to first NEW collected row; null means not observed',durationMs:'Attempt duration; null on unknown interruption time',
    startedAt:'Accepted start time; null if rejected before start',rows:'Rows available, including partial/resumed data',
    error:'Allowlisted error code only',completion:'limit_reached / source_exhausted / no_matches',
    generationMs:'Generation and browser handoff duration',bytes:'Generated file bytes across parts',
    parts:'Expected file parts',completedParts:'Browser-confirmed completed parts',handedOff:'All parts handed to browser',
    photosAttempted:'Photo embedding targets attempted',photosLoaded:'Photos successfully embedded',photosFailed:'Targets not embedded',
    photoPermission:'Optional photo-host permission granted',photosEnabled:'Photo embedding requested',
    requests:'HTTP requests while attempt active',rateLimits:'HTTP 429 responses',retries:'Limiter retry attempts',
    timeouts:'HTTP deadline expirations',networkErrors:'Fetch failures other than abort/deadline',
    pauses:'Limiter waits entered',pauseMs:'Observed limiter wait time in milliseconds'}[key] || key;
}
