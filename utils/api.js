// XPorter — X/Twitter GraphQL API Integration
// Uses the internal API through the user's authenticated browser session
// Dynamically extracts queryIds and bearer token from X's JS bundles

// Bearer token — dynamically extracted, falls back to config constant
const _C = (typeof XPORTER_CONFIG !== 'undefined') ? XPORTER_CONFIG : {};
const DEFAULT_BEARER_TOKEN = _C.FALLBACK_BEARER_TOKEN
  || 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
let activeBearerToken = DEFAULT_BEARER_TOKEN;

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
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('NETWORK_TIMEOUT');
    }
    throw err;
  }
}

// A body read shares fetchTimed's abort signal, so it can hit the same
// deadline after the headers already arrived — normalize it the same way,
// or the raw TimeoutError would bypass the retry path and churn stats.
async function readJsonTimed(response) {
  try {
    return await response.json();
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('NETWORK_TIMEOUT');
    }
    throw err;
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
  const mainPageHtml = await mainPageResponse.text();

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
      const jsText = await jsResponse.text();

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
    throw new Error('RATE_LIMITED');
  }

  if (response.status === 401 || response.status === 403) {
    noteAuthFailure();
    throw new Error('AUTH_ERROR');
  }

  if (response.status === 400 || response.status === 404) {
    const body = await response.text().catch(() => '');
    XLog.error(`GraphQL ${response.status} error for ${endpoint.operationName}:`, body.substring(0, 200));
    // Invalidate cache so next call tries fresh discovery
    discoveredEndpoints = null;
    endpointsCacheTime = 0;
    throw new Error('STALE_QUERY_ID');
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
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
    throw new Error('RATE_LIMITED');
  }
  if (response.status === 401 || response.status === 403) {
    noteAuthFailure();
    throw new Error('AUTH_ERROR');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    XLog.error(`[REST] Followers API error ${response.status}:`, body.substring(0, 500));
    throw new Error(`API_ERROR_${response.status}`);
  }

  const data = await readJsonTimed(response);

  // Parse REST v1.1 response into the same format used by GraphQL
  const users = (data.users || []).map(u => ({
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

  return parseFollowersResponse(data);
}

// ==================== Followers Response Parsing ====================

function parseFollowersResponse(data) {
  const result = data?.data?.user?.result;
  const timeline = result?.timeline_v2?.timeline || result?.timeline?.timeline;
  const instructions = timeline?.instructions || [];

  const users = [];
  let nextCursor = null;

  for (const instruction of instructions) {
    const entries = instruction.entries || [];

    if (instruction.type === 'TimelineAddEntries' || entries.length > 0) {
      for (const entry of entries) {
        const entryId = entry.entryId || '';

        // User entries
        if (entryId.startsWith('user-')) {
          const userResult = entry.content?.itemContent?.user_results?.result;
          if (userResult && userResult.__typename !== 'UserUnavailable') {
            const parsed = parseUserObject(userResult);
            if (parsed) users.push(parsed);
          }
        }

        // Cursor entries
        if (entryId.startsWith('cursor-bottom-')) {
          nextCursor = entry.content?.value || null;
        }
      }
    }
  }

  XLog.log(`Parsed ${users.length} users, nextCursor: ${nextCursor ? 'yes' : 'no'}`);
  return { users, nextCursor };
}

/**
 * Parse a single user object from the API response into a flat structure.
 * X has moved identity fields (name, screen_name, created_at) to `result.core`
 * and profile images to `result.avatar`. Stats remain in `result.legacy`.
 */
function parseUserObject(result) {
  if (!result) return null;
  const legacy = result.legacy;
  const core = result.core || {};
  if (!legacy) return null;

  // Identity fields: prefer core (new location), fall back to legacy
  const name = core.name || legacy.name || '';
  const screenName = core.screen_name || legacy.screen_name || '';
  const createdAt = core.created_at || legacy.created_at || '';

  // Profile image: prefer avatar (new location), fall back to legacy
  const rawImageUrl = result.avatar?.image_url || legacy.profile_image_url_https || '';
  const profileImageUrl = rawImageUrl.replace('_normal', '_400x400');

  return {
    id: result.rest_id,
    name: name,
    username: screenName,
    bio: (legacy.description || '').replace(/\n/g, ' '),
    location: core.location || legacy.location || '',
    url: legacy.url || '',
    followers_count: legacy.followers_count || 0,
    following_count: legacy.friends_count || 0,
    tweet_count: legacy.statuses_count || 0,
    listed_count: legacy.listed_count || 0,
    verified: result.is_blue_verified || false,
    protected: legacy.protected || false,
    created_at: createdAt,
    profile_image_url: profileImageUrl,
    profile_url: `https://x.com/${screenName}`
  };
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

  return parseTimelineResponse(data);
}

// ==================== Response Parsing ====================

function parseTimelineResponse(data) {
  // X may return data under either `timeline` or `timeline_v2` depending on API version
  const result = data?.data?.user?.result;
  const timeline = result?.timeline_v2?.timeline || result?.timeline?.timeline;
  return parseTimelineByInstructions(timeline?.instructions || [], result?.timeline_v2 ? 'timeline_v2' : 'timeline');
}

function parseSearchTimelineResponse(data) {
  const timeline = data?.data?.search_by_raw_query?.search_timeline?.timeline;
  return parseTimelineByInstructions(timeline?.instructions || [], 'search_timeline');
}

function parseTimelineByInstructions(instructions, sourceLabel = 'timeline') {
  XLog.log(`Response path: ${sourceLabel}, instructions: ${instructions.length}`);

  const tweets = [];
  const seenIds = new Set();
  let nextCursor = null;
  let previousCursor = null;

  function addTweet(tweet, { pinned = false } = {}) {
    if (!tweet?.id || seenIds.has(tweet.id)) return;
    if (pinned) tweet.is_pinned = true;
    seenIds.add(tweet.id);
    tweets.push(tweet);
  }

  for (const instruction of instructions) {
    // Handle pinned tweet entry
    if (instruction.type === 'TimelinePinEntry' && instruction.entry) {
      extractTimelineEntry(instruction.entry, { addTweet, setNextCursor, setPreviousCursor }, { pinned: true });
    }

    // Some instruction variants carry a single entry outside of `entries`.
    if (instruction.entry && instruction.type !== 'TimelinePinEntry') {
      extractTimelineEntry(instruction.entry, { addTweet, setNextCursor, setPreviousCursor });
    }

    const entries = instruction.entries || [];

    if (instruction.type === 'TimelineAddEntries' || entries.length > 0) {
      for (const entry of entries) {
        extractTimelineEntry(entry, { addTweet, setNextCursor, setPreviousCursor });
      }
    }
  }

  XLog.log(`Parsed ${tweets.length} tweets, nextCursor: ${nextCursor ? 'yes' : 'no'}`);
  return { tweets, nextCursor, previousCursor };

  function setNextCursor(value) {
    if (value) nextCursor = value;
  }

  function setPreviousCursor(value) {
    if (value) previousCursor = value;
  }
}

function extractTimelineEntry(entry, sinks, options = {}) {
  if (!entry) return;

  const entryId = entry.entryId || '';
  if (entryId.startsWith('cursor-bottom-')) {
    sinks.setNextCursor(entry.content?.value || null);
  }
  if (entryId.startsWith('cursor-top-')) {
    sinks.setPreviousCursor(entry.content?.value || null);
  }

  const directTweet = extractTweetResult(entry);
  if (directTweet) {
    sinks.addTweet(directTweet, options);
  }

  walkTimelineNode(entry.content, sinks, options);
}

function walkTimelineNode(node, sinks, options = {}) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      walkTimelineNode(item, sinks, options);
    }
    return;
  }

  if (typeof node !== 'object') return;

  const tweetResult = node.tweet_results?.result || node.itemContent?.tweet_results?.result;
  if (tweetResult) {
    const parsed = parseTweetObject(tweetResult);
    if (parsed) sinks.addTweet(parsed, options);
  }

  if (node.__typename === 'TimelineTimelineCursor' || node.cursorType) {
    if (node.cursorType === 'Bottom') sinks.setNextCursor(node.value || null);
    if (node.cursorType === 'Top') sinks.setPreviousCursor(node.value || null);
  }

  for (const value of Object.values(node)) {
    walkTimelineNode(value, sinks, options);
  }
}

function extractTweetResult(entry) {
  const itemContent = entry.content?.itemContent;
  if (!itemContent) return null;

  const result = itemContent.tweet_results?.result;
  if (!result) return null;

  return parseTweetObject(result);
}

function parseTweetObject(result) {
  // Handle tweet with visibility results
  if (result.__typename === 'TweetWithVisibilityResults') {
    result = result.tweet;
  }

  if (!result || result.__typename === 'TweetTombstone') {
    return null;
  }

  const legacy = result.legacy;
  if (!legacy) return null;

  const tweetUser = result.core?.user_results?.result;
  const userLegacy = tweetUser?.legacy || {};
  const userCore = tweetUser?.core || {};
  const views = result.views;

  const type = detectTweetType(legacy, result);

  // Get tweet text — handle note tweets (longer tweets)
  let text = legacy.full_text || '';
  if (result.note_tweet?.note_tweet_results?.result?.text) {
    text = result.note_tweet.note_tweet_results.result.text;
  }

  const media = extractMedia(legacy);

  // Author identity: prefer userCore (new location), fall back to userLegacy
  const authorName = userCore.name || userLegacy.name || '';
  const authorUsername = userCore.screen_name || userLegacy.screen_name || '';

  const article = extractArticle(result, authorUsername);
  // Article posts usually have an empty/near-empty full_text — surface the
  // article title there so the Text column is never blank for them.
  if (article.title && !text.trim()) {
    text = article.title;
  }

  // Link-card posts (YouTube, blog links, …) sometimes carry their destination
  // only in the card, not in entities.urls — fall back to the card URL.
  let urls = (legacy.entities?.urls || []).map(u => u.expanded_url).filter(Boolean).join(', ');
  if (!urls) {
    urls = extractCardUrl(result);
  }

  return {
    id: legacy.id_str,
    text: text,
    tweet_url: `https://x.com/${authorUsername}/status/${legacy.id_str}`,
    language: legacy.lang || '',
    type: type,
    author_name: authorName,
    author_username: authorUsername,
    view_count: views?.count || '',
    bookmark_count: legacy.bookmark_count || 0,
    favorite_count: legacy.favorite_count || 0,
    retweet_count: legacy.retweet_count || 0,
    reply_count: legacy.reply_count || 0,
    quote_count: legacy.quote_count || 0,
    created_at: legacy.created_at || '',
    source: extractSource(legacy.source),
    hashtags: (legacy.entities?.hashtags || []).map(h => h.text).join(', '),
    urls: urls,
    media_type: media.type,
    media_urls: media.urls,
    media_alt_texts: media.altTexts,
    article_title: article.title,
    article_url: article.url,
    article_text: article.text
  };
}

// ==================== Helpers ====================

function detectTweetType(legacy, result) {
  if (result.legacy?.retweeted_status_result || legacy.retweeted_status_result) {
    return 'retweet';
  }
  if (result.article?.article_results?.result) {
    return 'article';
  }
  if (legacy.in_reply_to_status_id_str) {
    return 'reply';
  }
  if (result.quoted_status_result) {
    return 'quote';
  }
  return 'tweet';
}

// X Articles (long-form). The timeline payload carries only the article's
// title/preview under result.article.article_results.result — the full body
// is never included, so title + canonical URL is all we can export here.
function extractArticle(result, authorUsername) {
  const art = result.article?.article_results?.result;
  if (!art) return { title: '', url: '', text: '' };

  const title = art.title || '';
  // plain_text arrives only when the endpoint honors withArticlePlainText;
  // fall back to the short preview_text otherwise.
  const articleText = art.plain_text || art.preview_text || '';
  const articleId = art.rest_id || art.id || '';
  let url = '';
  if (articleId && authorUsername) {
    url = `https://x.com/${authorUsername}/article/${articleId}`;
  } else if (result.legacy?.id_str && authorUsername) {
    url = `https://x.com/${authorUsername}/status/${result.legacy.id_str}`;
  }
  return { title, url, text: articleText };
}

// Destination URL of a link-preview card, best-effort. binding_values can be
// an array of {key, value} or a plain object depending on the card type.
function extractCardUrl(result) {
  const cardLegacy = result.card?.legacy;
  if (!cardLegacy) return '';

  const bv = cardLegacy.binding_values;
  const lookup = (key) => {
    if (Array.isArray(bv)) {
      const hit = bv.find(b => b?.key === key);
      return hit?.value?.string_value || '';
    }
    return bv?.[key]?.string_value || '';
  };

  return lookup('website_url') || lookup('card_url') || cardLegacy.url || '';
}

function extractSource(sourceHtml) {
  if (!sourceHtml) return '';
  const match = sourceHtml.match(/>([^<]+)</);
  return match ? match[1] : sourceHtml;
}

function extractMedia(legacy) {
  const media = legacy.extended_entities?.media || legacy.entities?.media || [];

  if (media.length === 0) {
    return { type: '', urls: '', altTexts: '' };
  }

  const types = new Set(media.map(m => m.type));
  let mediaType = '';
  if (types.has('video')) mediaType = 'video';
  else if (types.has('animated_gif')) mediaType = 'animated_gif';
  else if (types.has('photo')) mediaType = 'photo';

  const urls = media.map(m => {
    if (m.type === 'video' || m.type === 'animated_gif') {
      const variants = m.video_info?.variants || [];
      const mp4s = variants.filter(v => v.content_type === 'video/mp4');
      if (mp4s.length > 0) {
        mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        return mp4s[0].url;
      }
    }
    return m.media_url_https || m.media_url || '';
  }).join(', ');

  // Author-written accessibility descriptions. Joined with ' | ' (alt text is
  // free-form prose — commas would blur item boundaries); positions align with
  // media_urls so a blank slot means "this image has no alt".
  const altTexts = media.some(m => m.ext_alt_text)
    ? media.map(m => m.ext_alt_text || '').join(' | ')
    : '';

  return { type: mediaType, urls, altTexts };
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
    parseTweetObject,
    parseUserObject,
    discoverEndpoints,
    setLiveQueryId,
    getRateLimit,
    get BEARER_TOKEN() { return activeBearerToken; }
  };
}
