// XPorter — X/Twitter GraphQL API Integration
// Uses the internal API through the user's authenticated browser session
// Dynamically extracts queryIds and bearer token from X's JS bundles

// Bearer token — dynamically extracted, falls back to config constant
const _C = (typeof XPORTER_CONFIG !== 'undefined') ? XPORTER_CONFIG : {};
const DEFAULT_BEARER_TOKEN = _C.FALLBACK_BEARER_TOKEN
  || 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
let activeBearerToken = DEFAULT_BEARER_TOKEN;

// Every fetch gets its own controller so Stop can cancel an in-flight network
// request immediately instead of waiting for the 30-second deadline. The map
// records whether cancellation was user-driven so it stays distinct from a
// real timeout in retry/error handling.
const activeRequests = new Map();
const responseRequests = new WeakMap();

function abortActiveRequests() {
  for (const [controller, request] of activeRequests) {
    request.aborted = true;
    controller.abort();
  }
}

// Hardcoded queryIds as fallback — extracted from X.com JS bundles (Feb 2026)
const FALLBACK_ENDPOINTS = {
  UserByScreenName: {
    queryId: 'AWbeRIdkLtqTRN7yL_H8yw',
    operationName: 'UserByScreenName'
  },
  UserTweets: {
    queryId: 'eApPT8jppbYXlweF_ByTyA',
    operationName: 'UserTweets'
  },
  SearchTimeline: {
    queryId: 'R0u1RWRf748KzyGBXvOYRA',
    operationName: 'SearchTimeline'
  },
  Followers: {
    queryId: 'efNzdTpE-mkUcLARCd3RPQ',
    operationName: 'Followers'
  },
  Following: {
    queryId: 'M3LO-sJg6BCWdEliN_C2fQ',
    operationName: 'Following'
  },
  BlueVerifiedFollowers: {
    queryId: 'YGl_IyrL0bFU7KHxQoSRVg',
    operationName: 'BlueVerifiedFollowers'
  }
};

// Cache for discovered query IDs
let discoveredEndpoints = null;
let endpointsCacheTime = 0;
const ENDPOINTS_CACHE_TTL = _C.ENDPOINT_CACHE_TTL || (30 * 60 * 1000);
// A failed pass caches FALLBACK_ENDPOINTS — but only briefly. Caching a
// failure for the full TTL would suppress re-discovery for a day after one
// network blip.
const FALLBACK_CACHE_TTL = 10 * 60 * 1000;
// Effective TTL of whatever is cached right now (full for discovered data,
// short for the fallback stand-in).
let endpointsCacheTtl = ENDPOINTS_CACHE_TTL;
// The one bundle scan currently running, if any (single-flight guard).
let _discoveryInFlight = null;

// Persist discovered endpoints across MV3 service-worker restarts.
// The in-memory cache above is wiped every time the worker sleeps, which made
// the extension re-scan X's (multi-MB) JS bundles on every wake. Mirroring the
// cache to chrome.storage.local makes the first export after a wake instant.
const ENDPOINTS_STORAGE_KEY = 'xporter_discovered_endpoints';

async function _persistEndpoints() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local && discoveredEndpoints) {
      await chrome.storage.local.set({
        [ENDPOINTS_STORAGE_KEY]: {
          endpoints: discoveredEndpoints,
          time: endpointsCacheTime,
          bearer: activeBearerToken
        }
      });
    }
  } catch (_) { /* storage best-effort */ }
}

async function _hydrateEndpoints() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const r = await chrome.storage.local.get(ENDPOINTS_STORAGE_KEY);
      const cached = r[ENDPOINTS_STORAGE_KEY];
      if (cached?.endpoints && (Date.now() - (cached.time || 0)) < ENDPOINTS_CACHE_TTL) {
        discoveredEndpoints = cached.endpoints;
        endpointsCacheTime = cached.time || 0;
        endpointsCacheTtl = ENDPOINTS_CACHE_TTL; // only successful passes are persisted
        if (cached.bearer) activeBearerToken = cached.bearer;
        XLog.log('Endpoints hydrated from storage cache');
        return true;
      }
    }
  } catch (_) { /* storage best-effort */ }
  return false;
}

// Live queryIds captured from X.com's own network traffic (highest priority)
const liveQueryIds = {};

// A discovered bearer can rotate while the session cookies stay valid.
// Reverting to the long-lived public token is free (no bundle re-scan) and
// un-wedges the next attempt when the stale bearer was the real cause of a
// 401/403. Persist so a worker restart doesn't re-hydrate the bad token.
function noteAuthFailure() {
  if (activeBearerToken !== DEFAULT_BEARER_TOKEN) {
    XLog.warn('AUTH_ERROR with a discovered bearer — reverting to the built-in public token');
    activeBearerToken = DEFAULT_BEARER_TOKEN;
    _persistEndpoints();
  }
}

// A bearer scraped from X's bundles can expire independently of the user's
// session cookies. Retry the same request once with the long-lived built-in
// token instead of failing the export and requiring a manual second attempt.
async function fetchWithBearerFallback(url, buildOptions) {
  const bearerBeforeRequest = activeBearerToken;
  let response = await fetchTimed(url, buildOptions(bearerBeforeRequest));
  if ((response.status === 401 || response.status === 403) &&
      bearerBeforeRequest !== DEFAULT_BEARER_TOKEN) {
    discardResponse(response);
    noteAuthFailure();
    response = await fetchTimed(url, buildOptions(activeBearerToken));
  }
  return response;
}

// ==================== Timed fetch ====================
// Every network call must have a deadline: a fetch that never settles leaves
// the export stuck on "Resolving user…" with no error, no retry and no
// feedback — the single worst first-run experience (visible in churn data as
// exp_started=1, exp_err=0, items=0). Timeouts convert a hang into
// NETWORK_TIMEOUT, which the rate limiter retries visibly.
async function fetchTimed(url, options = {}, timeoutMs) {
  const ms = timeoutMs || _C.API_FETCH_TIMEOUT || 30000;
  const controller = new AbortController();
  const request = { aborted: false, timedOut: false, hasResponse: false };
  const timer = setTimeout(() => {
    request.timedOut = true;
    controller.abort();
  }, ms);
  activeRequests.set(controller, request);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    request.hasResponse = true;
    responseRequests.set(response, { controller, timer, request });
    return response;
  } catch (err) {
    if (request.aborted) {
      throw new Error('ABORTED');
    }
    if (request.timedOut || (err && err.name === 'TimeoutError')) {
      throw new Error('NETWORK_TIMEOUT');
    }
    throw err;
  } finally {
    // Successful responses stay cancellable until their body has been read.
    if (!request.hasResponse) {
      clearTimeout(timer);
      activeRequests.delete(controller);
    }
  }
}

function releaseResponse(response) {
  const lifecycle = responseRequests.get(response);
  if (!lifecycle) return;
  clearTimeout(lifecycle.timer);
  activeRequests.delete(lifecycle.controller);
  responseRequests.delete(response);
}

function discardResponse(response) {
  try { response.body?.cancel().catch(() => {}); } catch (_) { /* already closed */ }
  releaseResponse(response);
}

function normalizeBodyReadError(response, error) {
  if (!error || (error.name !== 'TimeoutError' && error.name !== 'AbortError')) return error;
  return new Error(responseRequests.get(response)?.request?.aborted ? 'ABORTED' : 'NETWORK_TIMEOUT');
}

async function readTextTimed(response) {
  try {
    return await response.text();
  } catch (err) {
    throw normalizeBodyReadError(response, err);
  } finally {
    releaseResponse(response);
  }
}

// A body read shares fetchTimed's abort signal, so it can hit the same
// deadline after the headers already arrived — normalize it the same way,
// or the raw TimeoutError would bypass the retry path and churn stats.
async function readJsonTimed(response) {
  try {
    return await response.json();
  } catch (err) {
    throw normalizeBodyReadError(response, err);
  } finally {
    releaseResponse(response);
  }
}

// ==================== Rate-limit budget tracking ====================
// X reports a separate quota for each endpoint via x-rate-limit-* headers.
// Keep readings keyed by operation so one endpoint can never pace another.
const rateLimits = Object.create(null);

function captureRateLimit(response, endpointKey) {
  if (!endpointKey) return;
  try {
    if (!response?.headers) {
      delete rateLimits[endpointKey];
      return;
    }

    const remaining = Number.parseInt(response.headers.get('x-rate-limit-remaining'), 10);
    const reset = Number.parseInt(response.headers.get('x-rate-limit-reset'), 10);
    const limit = Number.parseInt(response.headers.get('x-rate-limit-limit'), 10);

    if (!Number.isFinite(remaining) || remaining < 0 || !Number.isFinite(reset) || reset <= 0) {
      delete rateLimits[endpointKey];
      return;
    }

    rateLimits[endpointKey] = {
      remaining,                           // requests left in the current window
      reset,                               // unix SECONDS when the window resets
      limit: Number.isFinite(limit) ? limit : null,
      at: Date.now()                      // when we read it (freshness guard)
    };
  } catch (_) {
    delete rateLimits[endpointKey];
  }
}

function getRateLimit(endpointKey) {
  return rateLimits[endpointKey] || null;
}

// Feature flag constants (USER_FEATURES, USER_FIELD_TOGGLES, TWEETS_FEATURES,
// FOLLOWERS_FEATURES, FOLLOWERS_FIELD_TOGGLES) are loaded from /utils/api-features.js

// ==================== Dynamic QueryId Discovery ====================

/**
 * Discover current GraphQL query IDs and bearer token by parsing X's JS bundles.
 * Falls back to hardcoded values if discovery fails.
 */
async function discoverEndpoints(forceRefresh = false) {
  // Try the persisted cache first when memory was wiped by a worker restart.
  if (!forceRefresh && !discoveredEndpoints) {
    await _hydrateEndpoints();
  }

  // Return cached if still valid (unless explicitly forcing a refresh)
  if (!forceRefresh && discoveredEndpoints && (Date.now() - endpointsCacheTime) < endpointsCacheTtl) {
    return discoveredEndpoints;
  }

  XLog.log('Discovering GraphQL endpoints...');

  // Cap the whole pass: scanning several multi-MB bundles on a slow
  // connection can take minutes while the user stares at "Resolving user…".
  // On timeout we fall back to the known queryIds; the still-running scan is
  // left to finish and refresh the cache for the next call. Single-flight:
  // concurrent callers (e.g. withStaleRetry forcing a refresh while a
  // timed-out pass is still scanning) share one scan instead of stacking
  // multi-MB downloads onto an already slow connection.
  let timeoutId = null;
  try {
    const totalMs = _C.DISCOVERY_TOTAL_TIMEOUT || 25000;
    if (!_discoveryInFlight) {
      _discoveryInFlight = _discoverEndpointsInner().finally(() => { _discoveryInFlight = null; });
      _discoveryInFlight.catch(() => { /* stays handled even if every waiter times out first */ });
    }
    return await Promise.race([
      _discoveryInFlight,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('DISCOVERY_TIMEOUT')), totalMs);
      })
    ]);
  } catch (error) {
    XLog.warn('Discovery failed, using fallback endpoints:', error.message);
    discoveredEndpoints = { ...FALLBACK_ENDPOINTS };
    endpointsCacheTime = Date.now();
    endpointsCacheTtl = FALLBACK_CACHE_TTL;
    return discoveredEndpoints;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function _discoverEndpointsInner() {
  // Fetch X's main page to find JS bundle URLs
  const mainPageResponse = await fetchTimed('https://x.com', {
    credentials: 'include',
    headers: { 'User-Agent': navigator.userAgent }
  }, _C.DISCOVERY_FETCH_TIMEOUT || 15000);
  const mainPageHtml = await readTextTimed(mainPageResponse);

  // Find JS bundle URLs
  const scriptUrls = [];
  const scriptRegex = /src="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"]*\.js)"/g;
  let match;
  while ((match = scriptRegex.exec(mainPageHtml)) !== null) {
    scriptUrls.push(match[1]);
  }

  XLog.log(`Found ${scriptUrls.length} JS bundles to scan`);

  if (scriptUrls.length === 0) {
    throw new Error('No JS bundles found');
  }

  const targetOperations = ['UserByScreenName', 'UserTweets', 'SearchTimeline', 'Followers', 'Following', 'BlueVerifiedFollowers'];
  const found = {};
  let discoveredBearer = null;

  for (const url of scriptUrls) {
    if (targetOperations.every(op => found[op]) && discoveredBearer) break;

    try {
      const jsResponse = await fetchTimed(url, {}, _C.DISCOVERY_FETCH_TIMEOUT || 15000);
      const jsText = await readTextTimed(jsResponse);

      // Search for bearer token (pattern: "AAAAAAA..." — 100+ chars, URL-safe base64)
      if (!discoveredBearer) {
        const bearerMatch = jsText.match(/"(AAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{80,})"/)
          || jsText.match(/Bearer\s+(AAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{80,})/);
        if (bearerMatch) {
          discoveredBearer = bearerMatch[1];
          XLog.log('Dynamically extracted bearer token');
        }
      }

      // Batch approach: find ALL queryId/operationName pairs in one pass
      // X bundles endpoints in various formats, so we scan for all pairs at once
      const batchPatterns = [
        /queryId:"([^"]+)",operationName:"([^"]+)"/g,
        /\{queryId:"([^"]+)",operationName:"([^"]+)"/g,
        /operationName:"([^"]+)"[^}]{0,50}queryId:"([^"]+)"/g
      ];

      for (const pattern of batchPatterns) {
        let m;
        while ((m = pattern.exec(jsText)) !== null) {
          let qId, opName;
          // Different patterns capture in different order
          if (pattern.source.startsWith('operationName')) {
            opName = m[1]; qId = m[2];
          } else {
            qId = m[1]; opName = m[2];
          }
          if (targetOperations.includes(opName) && !found[opName]) {
            found[opName] = qId;
            XLog.log(`Found ${opName} queryId: ${qId}`);
          }
        }
      }

      // Fallback: also try individual per-operation patterns for any still-missing
      for (const opName of targetOperations) {
        if (found[opName]) continue;
        const fallbackPatterns = [
          new RegExp(`queryId:"([^"]+)"[^}]{0,300}operationName:"${opName}"`),
          new RegExp(`"${opName}"[^}]{0,300}queryId:"([^"]+)"`)
        ];
        for (const p of fallbackPatterns) {
          const fm = p.exec(jsText);
          if (fm) {
            found[opName] = fm[1];
            XLog.log(`Found ${opName} queryId (fallback): ${fm[1]}`);
            break;
          }
        }
      }
    } catch (e) {
      XLog.warn(`Error scanning bundle ${url}:`, e.message);
    }
  }

  // Update bearer token if dynamically extracted
  if (discoveredBearer) {
    activeBearerToken = discoveredBearer;
  }

  if (found.UserByScreenName && found.UserTweets) {
    // Log discovery results for debugging
    for (const op of targetOperations) {
      if (found[op]) {
        XLog.log(`✓ ${op}: discovered queryId = ${found[op]}`);
      } else {
        XLog.warn(`✗ ${op}: NOT found in bundles, using fallback = ${FALLBACK_ENDPOINTS[op]?.queryId || 'none'}`);
      }
    }
    discoveredEndpoints = {
      UserByScreenName: { queryId: found.UserByScreenName, operationName: 'UserByScreenName' },
      UserTweets: { queryId: found.UserTweets, operationName: 'UserTweets' },
      SearchTimeline: found.SearchTimeline
        ? { queryId: found.SearchTimeline, operationName: 'SearchTimeline' }
        : FALLBACK_ENDPOINTS.SearchTimeline,
      Followers: found.Followers
        ? { queryId: found.Followers, operationName: 'Followers' }
        : FALLBACK_ENDPOINTS.Followers,
      Following: found.Following
        ? { queryId: found.Following, operationName: 'Following' }
        : FALLBACK_ENDPOINTS.Following,
      BlueVerifiedFollowers: found.BlueVerifiedFollowers
        ? { queryId: found.BlueVerifiedFollowers, operationName: 'BlueVerifiedFollowers' }
        : FALLBACK_ENDPOINTS.BlueVerifiedFollowers
    };
    endpointsCacheTime = Date.now();
    endpointsCacheTtl = ENDPOINTS_CACHE_TTL; // real data → full lifetime again
    XLog.log('Endpoints discovered successfully');
    await _persistEndpoints();
    return discoveredEndpoints;
  }

  throw new Error(`Missing queryIds: ${targetOperations.filter(op => !found[op]).join(', ')}`);
}

// ==================== Auth ====================

async function getAuthTokens() {
  // Only the csrf token value is ever needed — the browser attaches the
  // session cookie itself via credentials:'include'. auth_token is checked
  // for EXISTENCE only; its value is deliberately never read into JS.
  return new Promise((resolve, reject) => {
    chrome.cookies.get({ url: 'https://x.com', name: 'ct0' }, (ct0Cookie) => {
      if (!ct0Cookie) {
        reject(new Error('NOT_LOGGED_IN'));
        return;
      }
      chrome.cookies.get({ url: 'https://x.com', name: 'auth_token' }, (authCookie) => {
        if (!authCookie) {
          reject(new Error('NOT_LOGGED_IN'));
          return;
        }
        resolve({
          csrfToken: ct0Cookie.value
        });
      });
    });
  });
}

// ==================== GraphQL Request ====================

async function graphqlRequest(endpoint, variables, features, fieldToggles) {
  const auth = await getAuthTokens();

  // IMPORTANT: Use encodeURIComponent, NOT URLSearchParams.
  // X's API rejects URLSearchParams encoding (spaces as + instead of %20, etc.)
  let url = `https://x.com/i/api/graphql/${endpoint.queryId}/${endpoint.operationName}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
  if (fieldToggles) {
    url += `&fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`;
  }

  const response = await fetchWithBearerFallback(url, (bearerToken) => ({
    method: 'GET',
    headers: {
      'authorization': `Bearer ${bearerToken}`,
      'x-csrf-token': auth.csrfToken,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'en'
    },
    credentials: 'include'
  }));

  // Read X's advertised budget from this response (even on errors) so the next
  // wait can be paced to it.
  captureRateLimit(response, endpoint.operationName);

  if (response.status === 429) {
    discardResponse(response);
    throw new Error('RATE_LIMITED');
  }

  if (response.status === 401 || response.status === 403) {
    discardResponse(response);
    noteAuthFailure();
    throw new Error('AUTH_ERROR');
  }

  if (response.status === 400 || response.status === 404) {
    const body = await readTextTimed(response).catch(() => '');
    XLog.error(`GraphQL ${response.status} error for ${endpoint.operationName}:`, body.substring(0, 200));
    // Invalidate cache so next call tries fresh discovery
    discoveredEndpoints = null;
    endpointsCacheTime = 0;
    throw new Error('STALE_QUERY_ID');
  }

  if (!response.ok) {
    const body = await readTextTimed(response).catch(() => '');
    XLog.error(`API error ${response.status}:`, body.substring(0, 500));
    throw new Error(`API_ERROR_${response.status}`);
  }

  const jsonData = await readJsonTimed(response);

  if (jsonData.errors) {
    XLog.error(`GraphQL errors for ${endpoint.operationName}:`, JSON.stringify(jsonData.errors).substring(0, 300));
  }

  return jsonData;
}

// ==================== Stale Query ID Retry Wrapper ====================

/**
 * Executes a GraphQL request with automatic retry on STALE_QUERY_ID.
 * Forces endpoint re-discovery on stale IDs, eliminating duplicated retry logic.
 */
async function withStaleRetry(endpointKey, makeRequest) {
  const triedIds = new Set();

  // Attempt 0: if we have a live-captured queryId from X.com's traffic, try it first
  if (liveQueryIds[endpointKey]) {
    const liveId = liveQueryIds[endpointKey];
    triedIds.add(liveId);
    try {
      const liveEndpoint = { queryId: liveId, operationName: endpointKey };
      XLog.log(`Trying ${endpointKey} with live-captured queryId: ${liveId}`);
      return await makeRequest(liveEndpoint);
    } catch (err) {
      if (err.message !== 'STALE_QUERY_ID') throw err;
      delete liveQueryIds[endpointKey];
      XLog.warn(`Live queryId for ${endpointKey} was stale, trying discovery...`);
    }
  }

  // Attempt 1: use discovered (or cached) endpoint
  const endpoints = await discoverEndpoints();
  const discoveredId = endpoints[endpointKey]?.queryId;
  if (discoveredId && !triedIds.has(discoveredId)) {
    triedIds.add(discoveredId);
    try {
      return await makeRequest(endpoints[endpointKey]);
    } catch (err) {
      if (err.message !== 'STALE_QUERY_ID') throw err;
      XLog.log(`Discovered queryId for ${endpointKey} was stale (${discoveredId}), re-discovering...`);
    }
  }

  // Attempt 2: force re-discovery from JS bundles
  const freshEndpoints = await discoverEndpoints(true);
  const freshId = freshEndpoints[endpointKey]?.queryId;
  if (freshId && !triedIds.has(freshId)) {
    triedIds.add(freshId);
    try {
      return await makeRequest(freshEndpoints[endpointKey]);
    } catch (err) {
      if (err.message !== 'STALE_QUERY_ID') throw err;
      XLog.log(`Fresh queryId for ${endpointKey} also stale (${freshId}), trying fallback...`);
    }
  }

  // Attempt 3: use hardcoded FALLBACK_ENDPOINTS as last resort
  const fallback = FALLBACK_ENDPOINTS[endpointKey];
  if (fallback && !triedIds.has(fallback.queryId)) {
    XLog.log(`Trying ${endpointKey} with hardcoded fallback queryId: ${fallback.queryId}`);
    return await makeRequest(fallback);
  }

  XLog.error(`All queryIds exhausted for ${endpointKey}. Tried: ${[...triedIds].join(', ')}`);
  throw new Error('STALE_QUERY_ID');
}

/**
 * Store a live-captured queryId from X.com's own network traffic.
 * Called from the service worker when the content script intercepts a GraphQL request.
 */
function setLiveQueryId(operationName, queryId) {
  // Defense in depth: the value originates from a page-spoofable postMessage
  // relay. content.js and the SW validate too, but this is the last gate
  // before the id is interpolated into an authenticated request URL.
  if (!FALLBACK_ENDPOINTS[operationName]) return;
  if (typeof queryId !== 'string' || !/^[A-Za-z0-9_-]{10,40}$/.test(queryId)) return;
  liveQueryIds[operationName] = queryId;
  XLog.log(`Live queryId captured: ${operationName} = ${queryId}`);
  // Also update discovered endpoints cache if it exists
  if (discoveredEndpoints && discoveredEndpoints[operationName]) {
    discoveredEndpoints[operationName] = { queryId, operationName };
  }
}

// ==================== User Lookup ====================

async function getUserByScreenName(screenName) {
  const variables = {
    screen_name: screenName,
    withSafetyModeUserFields: true
  };

  const data = await withStaleRetry('UserByScreenName', (endpoint) =>
    graphqlRequest(endpoint, variables, USER_FEATURES, USER_FIELD_TOGGLES)
  );

  const userResult = data?.data?.user?.result;

  if (!userResult) {
    throw new Error('USER_NOT_FOUND');
  }

  if (userResult.__typename === 'UserUnavailable') {
    if (userResult.reason === 'Suspended') throw new Error('USER_SUSPENDED');
    throw new Error('USER_UNAVAILABLE');
  }

  // X is gradually moving fields out of `legacy`; a profile without it must
  // not crash with a raw TypeError (parseUserObject guards the same way).
  const legacy = userResult.legacy || {};
  const core = userResult.core || {};

  return {
    id: userResult.rest_id,
    name: core.name || legacy.name || '',
    screenName: core.screen_name || legacy.screen_name || '',
    profileImageUrl: (legacy.profile_image_url_https || '').replace('_normal', '_200x200'),
    isProtected: legacy.protected || false,
    tweetCount: legacy.statuses_count || 0,
    followersCount: legacy.followers_count || 0,
    followingCount: legacy.friends_count || 0
  };
}

// ==================== Followers/Following Fetching ====================

async function fetchFollowers(userId, cursor = null, count = 100) {
  // X has deprecated the GraphQL Followers endpoint (returns 404).
  // Use REST v1.1 /followers/list.json as a reliable alternative.
  // count up to 200 is accepted here; 100 keeps each page reasonable while
  // still cutting the request count 5x vs the old default of 20.
  const auth = await getAuthTokens();

  let url = `https://x.com/i/api/1.1/followers/list.json?user_id=${userId}&count=${count}&skip_status=true&include_user_entities=false`;
  if (cursor && cursor !== '0' && cursor !== '-1') {
    url += `&cursor=${cursor}`;
  }

  XLog.log(`[REST] Fetching Followers via v1.1 API (cursor: ${cursor || 'initial'})`);

  const response = await fetchWithBearerFallback(url, (bearerToken) => ({
    method: 'GET',
    headers: {
      'authorization': `Bearer ${bearerToken}`,
      'x-csrf-token': auth.csrfToken,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'en'
    },
    credentials: 'include'
  }));

  captureRateLimit(response, 'Followers');

  if (response.status === 429) {
    discardResponse(response);
    throw new Error('RATE_LIMITED');
  }
  if (response.status === 401 || response.status === 403) {
    discardResponse(response);
    noteAuthFailure();
    throw new Error('AUTH_ERROR');
  }
  if (!response.ok) {
    const body = await readTextTimed(response).catch(() => '');
    XLog.error(`[REST] Followers API error ${response.status}:`, body.substring(0, 500));
    throw new Error(`API_ERROR_${response.status}`);
  }

  const data = await readJsonTimed(response);

  // Parse REST v1.1 response into the same format used by GraphQL
  const users = (data.users || []).filter(u => u?.id_str || Number.isFinite(u?.id)).map(u => ({
    id: u.id_str || String(u.id),
    name: u.name || '',
    username: u.screen_name || '',
    bio: (u.description || '').replace(/\n/g, ' '),
    location: u.location || '',
    url: u.url || '',
    followers_count: u.followers_count || 0,
    following_count: u.friends_count || 0,
    tweet_count: u.statuses_count || 0,
    listed_count: u.listed_count || 0,
    verified: u.verified || u.is_blue_verified || false,
    protected: u.protected || false,
    created_at: u.created_at || '',
    profile_image_url: (u.profile_image_url_https || '').replace('_normal', '_400x400'),
    profile_url: `https://x.com/${u.screen_name}`
  }));

  // REST v1.1 uses numeric cursors; "0" means no more pages
  const nextCursorStr = data.next_cursor_str || String(data.next_cursor || 0);
  const nextCursor = (nextCursorStr && nextCursorStr !== '0') ? nextCursorStr : null;

  XLog.log(`[REST] Parsed ${users.length} followers, nextCursor: ${nextCursor ? 'yes' : 'no'}`);
  return { users, nextCursor };
}

async function fetchFollowing(userId, cursor = null, count = 50) {
  return _fetchUserList('Following', userId, cursor, count);
}

async function fetchVerifiedFollowers(userId, cursor = null, count = 50) {
  return _fetchUserList('BlueVerifiedFollowers', userId, cursor, count);
}

/**
 * Internal helper: fetch a user list (following, verified followers)
 * Note: Followers now uses REST v1.1 directly (see fetchFollowers above)
 */
async function _fetchUserList(endpointKey, userId, cursor, count) {
  const variables = {
    userId: userId,
    count: count,
    includePromotedContent: false
  };
  if (cursor) {
    variables.cursor = cursor;
  }

  const data = await withStaleRetry(endpointKey, (endpoint) =>
    graphqlRequest(endpoint, variables, FOLLOWERS_FEATURES, FOLLOWERS_FIELD_TOGGLES)
  );

  return XPorterApiParsers.parseFollowersResponse(data);
}

// ==================== Tweet Fetching ====================

async function fetchUserTweets(userId, cursor = null, count = 20) {
  const variables = {
    userId: userId,
    count: count,
    includePromotedContent: true,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
    withV2Timeline: true
  };

  if (cursor) {
    variables.cursor = cursor;
  }

  const data = await withStaleRetry('UserTweets', (endpoint) =>
    graphqlRequest(endpoint, variables, TWEETS_FEATURES, {
      // Ask X to inline the plain text of X Articles so long-form posts can be
      // exported in full. X's own client sends this toggle (with false).
      withArticlePlainText: true
    })
  );

  return XPorterApiParsers.parseTimelineResponse(data);
}

// Export for use in service worker
if (typeof globalThis !== 'undefined') {
  globalThis.XPorterAPI = {
    getAuthTokens,
    getUserByScreenName,
    fetchUserTweets,
    fetchFollowers,
    fetchFollowing,
    fetchVerifiedFollowers,
    parseTweetObject: XPorterApiParsers.parseTweetObject,
    parseUserObject: XPorterApiParsers.parseUserObject,
    parseSearchTimelineResponse: XPorterApiParsers.parseSearchTimelineResponse,
    discoverEndpoints,
    setLiveQueryId,
    getRateLimit,
    abortActiveRequests,
    get BEARER_TOKEN() { return activeBearerToken; }
  };
}
