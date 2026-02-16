// XPorter — X/Twitter GraphQL API Integration
// Uses the internal API through the user's authenticated browser session
// Dynamically extracts queryIds from X's JS bundles, with hardcoded fallbacks

const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// Hardcoded queryIds as fallback — verified working as of Feb 2026
const FALLBACK_ENDPOINTS = {
  UserByScreenName: {
    queryId: 'AWbeRIdkLtqTRN7yL_H8yw',
    operationName: 'UserByScreenName'
  },
  UserTweets: {
    queryId: 'eApPT8jppbYXlweF_ByTyA',
    operationName: 'UserTweets'
  }
};

// Cache for discovered query IDs
let discoveredEndpoints = null;
let endpointsCacheTime = 0;
const ENDPOINTS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
let usingFallbacks = false; // Track whether we're using hardcoded fallback IDs

// Features for UserByScreenName — verified working (must include all required flags)
const USER_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  // Additional required features (X returns 400 without these)
  responsive_web_profile_redirect_enabled: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  highlights_content_canvas_enabled: true
};

const USER_FIELD_TOGGLES = {
  withAuxiliaryUserSkus: false
};

// Features for UserTweets — verified working (all 39 flags required by X)
const TWEETS_FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch_enabled: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  can_edit_tweet_hints_enabled: true,
  vxtwitter_tweet_results_fetch_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  // Grok-related features (required as of 2025+)
  responsive_web_grok_annotations_enabled: true,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_analysis_button_from_backend: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  // Additional required features
  profile_label_improvements_pcf_label_in_post_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_profile_redirect_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  rweb_video_screen_enabled: true,
  tweet_awards_web_tipping_enabled: true,
  post_ctas_fetch_enabled: true,
  premium_content_api_read_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true
};

// ==================== Dynamic QueryId Discovery ====================

/**
 * Discover current GraphQL query IDs by parsing X's JS bundles.
 * Falls back to hardcoded IDs if discovery fails.
 */
async function discoverEndpoints(forceRefresh = false) {
  // Return cached if still valid (unless explicitly forcing a refresh)
  if (!forceRefresh && discoveredEndpoints && (Date.now() - endpointsCacheTime) < ENDPOINTS_CACHE_TTL) {
    return discoveredEndpoints;
  }

  console.log('XPorter: Discovering GraphQL endpoints...');

  try {
    // Fetch X's main page to find JS bundle URLs
    const mainPageResponse = await fetch('https://x.com', {
      credentials: 'include',
      headers: { 'User-Agent': navigator.userAgent }
    });
    const mainPageHtml = await mainPageResponse.text();

    // Find JS bundle URLs
    const scriptUrls = [];
    const scriptRegex = /src="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"]*\.js)"/g;
    let match;
    while ((match = scriptRegex.exec(mainPageHtml)) !== null) {
      scriptUrls.push(match[1]);
    }

    console.log(`XPorter: Found ${scriptUrls.length} JS bundles to scan`);

    if (scriptUrls.length === 0) {
      throw new Error('No JS bundles found');
    }

    const targetOperations = ['UserByScreenName', 'UserTweets'];
    const found = {};

    for (const url of scriptUrls) {
      if (targetOperations.every(op => found[op])) break;

      try {
        const jsResponse = await fetch(url);
        const jsText = await jsResponse.text();

        for (const opName of targetOperations) {
          if (found[opName]) continue;

          // Multiple patterns to handle X's JS bundling
          const patterns = [
            new RegExp(`queryId:"([^"]+)",operationName:"${opName}"`),
            new RegExp(`\\{queryId:"([^"]+)",operationName:"${opName}"`),
            new RegExp(`operationName:"${opName}"[^}]*queryId:"([^"]+)"`),
            new RegExp(`queryId:"([^"]+)"[^}]{0,200}operationName:"${opName}"`)
          ];

          for (const pattern of patterns) {
            const m = pattern.exec(jsText);
            if (m) {
              found[opName] = m[1];
              console.log(`XPorter: Found ${opName} queryId: ${m[1]}`);
              break;
            }
          }
        }
      } catch (e) {
        console.warn(`XPorter: Error scanning bundle ${url}:`, e.message);
      }
    }

    if (found.UserByScreenName && found.UserTweets) {
      discoveredEndpoints = {
        UserByScreenName: { queryId: found.UserByScreenName, operationName: 'UserByScreenName' },
        UserTweets: { queryId: found.UserTweets, operationName: 'UserTweets' }
      };
      endpointsCacheTime = Date.now();
      console.log('XPorter: Endpoints discovered:', discoveredEndpoints);
      return discoveredEndpoints;
    }

    throw new Error(`Missing queryIds: ${targetOperations.filter(op => !found[op]).join(', ')}`);
  } catch (error) {
    console.warn('XPorter: Discovery failed, using fallback endpoints:', error.message);
    discoveredEndpoints = { ...FALLBACK_ENDPOINTS };
    endpointsCacheTime = Date.now();
    usingFallbacks = true;
    return discoveredEndpoints;
  }
}

// ==================== Auth ====================

async function getAuthTokens() {
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
          csrfToken: ct0Cookie.value,
          authToken: authCookie.value
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

  console.log(`XPorter: Fetching ${endpoint.operationName} (queryId: ${endpoint.queryId})`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'authorization': `Bearer ${BEARER_TOKEN}`,
      'x-csrf-token': auth.csrfToken,
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en'
    },
    credentials: 'include'
  });

  if (response.status === 429) {
    throw new Error('RATE_LIMITED');
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('AUTH_ERROR');
  }

  if (response.status === 400) {
    const body = await response.text().catch(() => '');
    console.error('XPorter: 400 error body:', body.substring(0, 500));
    // Invalidate cache so next call tries fresh discovery
    discoveredEndpoints = null;
    endpointsCacheTime = 0;
    usingFallbacks = false;
    throw new Error('STALE_QUERY_ID');
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`XPorter: API error ${response.status}:`, body.substring(0, 500));
    throw new Error(`API_ERROR_${response.status}`);
  }

  return response.json();
}

// ==================== User Lookup ====================

async function getUserByScreenName(screenName) {
  const endpoints = await discoverEndpoints();

  const variables = {
    screen_name: screenName,
    withSafetyModeUserFields: true
  };

  let data;
  try {
    data = await graphqlRequest(endpoints.UserByScreenName, variables, USER_FEATURES, USER_FIELD_TOGGLES);
  } catch (err) {
    if (err.message === 'STALE_QUERY_ID') {
      console.log('XPorter: Retrying UserByScreenName with fresh queryIds...');
      // Force fresh discovery — don't use cached/fallback endpoints
      const freshEndpoints = await discoverEndpoints(true);
      data = await graphqlRequest(freshEndpoints.UserByScreenName, variables, USER_FEATURES, USER_FIELD_TOGGLES);
    } else {
      throw err;
    }
  }

  const userResult = data?.data?.user?.result;

  if (!userResult) {
    throw new Error('USER_NOT_FOUND');
  }

  if (userResult.__typename === 'UserUnavailable') {
    if (userResult.reason === 'Suspended') throw new Error('USER_SUSPENDED');
    throw new Error('USER_UNAVAILABLE');
  }

  const legacy = userResult.legacy;

  return {
    id: userResult.rest_id,
    name: legacy.name,
    screenName: legacy.screen_name,
    isProtected: legacy.protected || false,
    tweetCount: legacy.statuses_count
  };
}

// ==================== Tweet Fetching ====================

async function fetchUserTweets(userId, cursor = null, count = 20) {
  const endpoints = await discoverEndpoints();

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

  let data;
  try {
    data = await graphqlRequest(endpoints.UserTweets, variables, TWEETS_FEATURES, null);
  } catch (err) {
    if (err.message === 'STALE_QUERY_ID') {
      console.log('XPorter: Retrying UserTweets with fresh queryIds...');
      // Force fresh discovery — don't use cached/fallback endpoints
      const freshEndpoints = await discoverEndpoints(true);
      data = await graphqlRequest(freshEndpoints.UserTweets, variables, TWEETS_FEATURES, null);
    } else {
      throw err;
    }
  }

  return parseTimelineResponse(data);
}

// ==================== Response Parsing ====================

function parseTimelineResponse(data) {
  // X may return data under either `timeline` or `timeline_v2` depending on API version
  const result = data?.data?.user?.result;
  const timeline = result?.timeline_v2?.timeline || result?.timeline?.timeline;
  const instructions = timeline?.instructions || [];

  console.log(`XPorter: Response path: ${result?.timeline_v2 ? 'timeline_v2' : 'timeline'}, instructions: ${instructions.length}`);

  const tweets = [];
  let nextCursor = null;
  let previousCursor = null;

  for (const instruction of instructions) {
    // Handle pinned tweet entry
    if (instruction.type === 'TimelinePinEntry' && instruction.entry) {
      const pinned = extractTweetResult(instruction.entry);
      if (pinned) tweets.push(pinned);
    }

    const entries = instruction.entries || [];

    if (instruction.type === 'TimelineAddEntries' || entries.length > 0) {
      for (const entry of entries) {
        const entryId = entry.entryId || '';

        // Tweet entries
        if (entryId.startsWith('tweet-')) {
          const tweetResult = extractTweetResult(entry);
          if (tweetResult) {
            tweets.push(tweetResult);
          }
        }

        // Profile conversation threads — multiple tweets in one entry
        if (entryId.startsWith('profile-conversation-')) {
          if (entry.content?.items) {
            for (const item of entry.content.items) {
              const itemResult = item?.item?.itemContent?.tweet_results?.result;
              if (itemResult) {
                const parsed = parseTweetObject(itemResult);
                if (parsed) tweets.push(parsed);
              }
            }
          }
        }

        // Cursor entries for pagination
        if (entryId.startsWith('cursor-bottom-')) {
          nextCursor = entry.content?.value || null;
        }
        if (entryId.startsWith('cursor-top-')) {
          previousCursor = entry.content?.value || null;
        }
      }
    }
  }

  console.log(`XPorter: Parsed ${tweets.length} tweets, nextCursor: ${nextCursor ? 'yes' : 'no'}`);
  return { tweets, nextCursor, previousCursor };
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

  const core = result.core?.user_results?.result;
  const userLegacy = core?.legacy || {};
  const views = result.views;

  const type = detectTweetType(legacy, result);

  // Get tweet text — handle note tweets (longer tweets)
  let text = legacy.full_text || '';
  if (result.note_tweet?.note_tweet_results?.result?.text) {
    text = result.note_tweet.note_tweet_results.result.text;
  }

  const media = extractMedia(legacy);

  return {
    id: legacy.id_str,
    text: text,
    tweet_url: `https://x.com/${userLegacy.screen_name}/status/${legacy.id_str}`,
    language: legacy.lang || '',
    type: type,
    author_name: userLegacy.name || '',
    author_username: userLegacy.screen_name || '',
    view_count: views?.count || '',
    bookmark_count: legacy.bookmark_count || 0,
    favorite_count: legacy.favorite_count || 0,
    retweet_count: legacy.retweet_count || 0,
    reply_count: legacy.reply_count || 0,
    quote_count: legacy.quote_count || 0,
    created_at: legacy.created_at || '',
    source: extractSource(legacy.source),
    hashtags: (legacy.entities?.hashtags || []).map(h => h.text).join(', '),
    urls: (legacy.entities?.urls || []).map(u => u.expanded_url).join(', '),
    media_type: media.type,
    media_urls: media.urls
  };
}

// ==================== Helpers ====================

function detectTweetType(legacy, result) {
  if (result.legacy?.retweeted_status_result || legacy.retweeted_status_result) {
    return 'retweet';
  }
  if (legacy.in_reply_to_status_id_str) {
    return 'reply';
  }
  if (result.quoted_status_result) {
    return 'quote';
  }
  return 'tweet';
}

function extractSource(sourceHtml) {
  if (!sourceHtml) return '';
  const match = sourceHtml.match(/>([^<]+)</);
  return match ? match[1] : sourceHtml;
}

function extractMedia(legacy) {
  const media = legacy.extended_entities?.media || legacy.entities?.media || [];

  if (media.length === 0) {
    return { type: '', urls: '' };
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

  return { type: mediaType, urls };
}

// Export for use in service worker
if (typeof globalThis !== 'undefined') {
  globalThis.XPorterAPI = {
    getAuthTokens,
    getUserByScreenName,
    fetchUserTweets,
    parseTweetObject,
    discoverEndpoints,
    BEARER_TOKEN
  };
}
