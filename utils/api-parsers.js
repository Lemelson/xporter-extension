// XPorter — response parser module
// Pure normalization of X GraphQL/REST-shaped objects. Network/auth/queryId
// concerns stay in api.js; fixtures can exercise this module directly.

(function () {
  function parseFollowersResponse(data) {
    const result = data?.data?.user?.result;
    const timeline = result?.timeline_v2?.timeline || result?.timeline?.timeline;
    const instructions = timeline?.instructions || [];
    const users = [];
    let nextCursor = null;

    for (const instruction of instructions) {
      const entries = instruction.entries || [];
      if (instruction.type !== 'TimelineAddEntries' && entries.length === 0) continue;
      for (const entry of entries) {
        const entryId = entry.entryId || '';
        if (entryId.startsWith('user-')) {
          const userResult = entry.content?.itemContent?.user_results?.result;
          if (userResult && userResult.__typename !== 'UserUnavailable') {
            const parsed = parseUserObject(userResult);
            if (parsed) users.push(parsed);
          }
        }
        if (entryId.startsWith('cursor-bottom-')) {
          nextCursor = entry.content?.value || null;
        }
      }
    }

    XLog.log(`Parsed ${users.length} users, nextCursor: ${nextCursor ? 'yes' : 'no'}`);
    return { users, nextCursor };
  }

  function parseUserObject(result) {
    if (!result?.rest_id) return null;
    const legacy = result.legacy;
    const core = result.core || {};
    if (!legacy) return null;

    const name = core.name || legacy.name || '';
    const screenName = core.screen_name || legacy.screen_name || '';
    const createdAt = core.created_at || legacy.created_at || '';
    const rawImageUrl = result.avatar?.image_url || legacy.profile_image_url_https || '';

    return {
      id: result.rest_id,
      name,
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
      profile_image_url: rawImageUrl.replace('_normal', '_400x400'),
      profile_url: `https://x.com/${screenName}`
    };
  }

  function parseAboutAccountResponse(data) {
    const result = data?.data?.user_result_by_screen_name?.result
      || data?.data?.user?.result;
    const about = result?.about_profile || {};
    const usernameChanges = about.username_changes || {};
    return {
      accountBasedIn: about.account_based_in || '',
      locationAccurate: typeof about.location_accurate === 'boolean'
        ? about.location_accurate
        : null,
      accountSource: about.source || '',
      affiliateUsername: about.affiliate_username || '',
      premiumSince: normalizeAccountTimestamp(
        result?.verified_since ?? about.verified_since
      ),
      usernameChangeCount: normalizeNonNegativeInteger(usernameChanges.count),
      usernameLastChangedAt: normalizeAccountTimestamp(
        usernameChanges.last_changed_at_msec
      )
    };
  }

  function normalizeNonNegativeInteger(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
  }

  function normalizeAccountTimestamp(value) {
    if (value === undefined || value === null || value === '') return '';

    if (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
    }

    let milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
    if (milliseconds >= 1e14) milliseconds /= 1000;
    else if (milliseconds < 1e11) milliseconds *= 1000;

    // X launched in 2006. Values outside the product's lifetime are sentinel
    // or malformed values and should not become misleading export dates.
    const earliest = Date.UTC(2006, 0, 1);
    const latest = Date.now() + (366 * 24 * 60 * 60 * 1000);
    if (milliseconds < earliest || milliseconds > latest) return '';

    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function parseTimelineResponse(data) {
    const result = data?.data?.user?.result;
    const timeline = result?.timeline_v2?.timeline || result?.timeline?.timeline;
    return parseTimelineByInstructions(
      timeline?.instructions || [],
      result?.timeline_v2 ? 'timeline_v2' : 'timeline'
    );
  }

  function parseSearchTimelineResponse(data) {
    const timeline = data?.data?.search_by_raw_query?.search_timeline?.timeline;
    return parseTimelineByInstructions(timeline?.instructions || [], 'search_timeline');
  }

  function parseBookmarksResponse(data) {
    const timeline = data?.data?.bookmark_timeline_v2?.timeline
      || data?.data?.bookmark_timeline?.timeline;
    return parseTimelineByInstructions(timeline?.instructions || [], 'bookmark_timeline_v2');
  }

  function parseTweetResultsResponse(data) {
    const results = data?.data?.tweetResult;
    if (!Array.isArray(results)) return [];
    const tweets = [];
    const seenIds = new Set();
    for (const entry of results) {
      const parsed = parseTweetObject(entry?.result);
      if (!parsed?.id || seenIds.has(parsed.id)) continue;
      seenIds.add(parsed.id);
      tweets.push(parsed);
    }
    return tweets;
  }

  function parseTimelineByInstructions(instructions, sourceLabel = 'timeline') {
    XLog.log(`Response path: ${sourceLabel}, instructions: ${instructions.length}`);
    const tweets = [];
    const seenIds = new Set();
    let nextCursor = null;
    let previousCursor = null;
    const sinks = {
      addTweet(tweet, { pinned = false } = {}) {
        if (!tweet?.id || seenIds.has(tweet.id)) return;
        if (pinned) tweet.is_pinned = true;
        seenIds.add(tweet.id);
        tweets.push(tweet);
      },
      setNextCursor(value) { if (value) nextCursor = value; },
      setPreviousCursor(value) { if (value) previousCursor = value; }
    };

    for (const instruction of instructions) {
      if (instruction.type === 'TimelinePinEntry' && instruction.entry) {
        extractTimelineEntry(instruction.entry, sinks, { pinned: true });
      }
      if (instruction.entry && instruction.type !== 'TimelinePinEntry') {
        extractTimelineEntry(instruction.entry, sinks);
      }
      const entries = instruction.entries || [];
      if (instruction.type === 'TimelineAddEntries' || entries.length > 0) {
        for (const entry of entries) extractTimelineEntry(entry, sinks);
      }
      // Deep conversation/search pages can append rows through
      // TimelineAddToModule instead of TimelineAddEntries. The module item
      // wraps itemContent under `item`, so walk the whole item rather than
      // pretending it has the ordinary entry.content shape.
      const moduleItems = instruction.moduleItems || [];
      for (const moduleItem of moduleItems) {
        walkTimelineNode(moduleItem, sinks);
      }
    }

    attachReplyContexts(tweets);
    XLog.log(`Parsed ${tweets.length} tweets, nextCursor: ${nextCursor ? 'yes' : 'no'}`);
    return { tweets, nextCursor, previousCursor };
  }

  // UserTweetsAndReplies includes foreign conversation rows so X can render
  // the Replies tab. Keep those rows available long enough to attach the
  // direct parent to the profile reply; the worker may then filter the foreign
  // row without losing who was answered or what that post said.
  function attachReplyContexts(tweets) {
    const byId = new Map();
    for (const tweet of tweets) {
      if (tweet?.id && !byId.has(String(tweet.id))) {
        byId.set(String(tweet.id), tweet);
      }
    }
    for (const tweet of tweets) {
      const parentId = tweet?.reply_to_id ? String(tweet.reply_to_id) : '';
      const parent = parentId ? byId.get(parentId) : null;
      if (!parent || parent === tweet) continue;
      tweet.reply_to_post = postContext(parent);
    }
  }

  function postContext(tweet) {
    const context = {
      id: tweet.id,
      type: tweet.type,
      text: tweet.text,
      tweet_url: tweet.tweet_url,
      author_name: tweet.author_name,
      author_username: tweet.author_username,
      created_at: tweet.created_at,
      media_type: tweet.media_type,
      media_urls: tweet.media_urls,
      media_alt_texts: tweet.media_alt_texts,
      article_title: tweet.article_title,
      article_url: tweet.article_url,
      article_text: tweet.article_text,
      reply_to_id: tweet.reply_to_id,
      reply_to_username: tweet.reply_to_username,
      conversation_id: tweet.conversation_id
    };
    const metricPresence = tweet._context_metric_presence;
    for (const key of [
      'view_count', 'bookmark_count', 'favorite_count',
      'retweet_count', 'reply_count', 'quote_count'
    ]) {
      if (!metricPresence || metricPresence[key] === true) {
        context[key] = tweet[key];
      }
    }
    if (tweet.quoted_post) {
      context.quoted_post = { ...tweet.quoted_post };
    }
    return context;
  }

  function extractTimelineEntry(entry, sinks, options = {}) {
    if (!entry) return;
    const entryId = entry.entryId || '';
    if (entryId.startsWith('cursor-bottom-')) sinks.setNextCursor(entry.content?.value || null);
    if (entryId.startsWith('cursor-top-')) sinks.setPreviousCursor(entry.content?.value || null);

    const directTweet = extractTweetResult(entry);
    if (directTweet) sinks.addTweet(directTweet, options);
    walkTimelineNode(entry.content, sinks, options);
  }

  function walkTimelineNode(node, sinks, options = {}) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) walkTimelineNode(item, sinks, options);
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
    for (const value of Object.values(node)) walkTimelineNode(value, sinks, options);
  }

  function extractTweetResult(entry) {
    const result = entry.content?.itemContent?.tweet_results?.result;
    return result ? parseTweetObject(result) : null;
  }

  function parseTweetObject(result, options = {}) {
    if (result?.__typename === 'TweetWithVisibilityResults') result = result.tweet;
    if (!result || result.__typename === 'TweetTombstone') return null;
    const legacy = result.legacy;
    if (!legacy?.id_str) return null;

    const tweetUser = result.core?.user_results?.result;
    const userLegacy = tweetUser?.legacy || {};
    const userCore = tweetUser?.core || {};
    const authorName = userCore.name || userLegacy.name || '';
    const authorUsername = userCore.screen_name || userLegacy.screen_name || '';
    let text = result.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || '';
    const media = extractMedia(legacy);
    const article = extractArticle(result, authorUsername);
    if (article.title && !text.trim()) text = article.title;

    let urls = (legacy.entities?.urls || []).map(url => url.expanded_url).filter(Boolean).join(', ');
    if (!urls) urls = extractCardUrl(result);
    const statusUrl = authorUsername
      ? `https://x.com/${authorUsername}/status/${legacy.id_str}`
      : `https://x.com/i/web/status/${legacy.id_str}`;
    let quotedResult = options.includeQuotedPost === false
      ? null
      : result.quoted_status_result?.result;
    if (quotedResult?.__typename === 'TweetWithVisibilityResults') {
      quotedResult = quotedResult.tweet;
    }
    const quotedTweet = quotedResult
      ? parseTweetObject(quotedResult, { includeQuotedPost: false })
      : null;
    const quotedLegacy = quotedResult?.legacy || {};

    const parsed = {
      id: legacy.id_str,
      text,
      tweet_url: statusUrl,
      language: legacy.lang || '',
      type: detectTweetType(legacy, result),
      author_name: authorName,
      author_username: authorUsername,
      reply_to_id: legacy.in_reply_to_status_id_str || '',
      reply_to_username: legacy.in_reply_to_screen_name || '',
      conversation_id: legacy.conversation_id_str || '',
      view_count: result.views?.count || '',
      bookmark_count: legacy.bookmark_count || 0,
      favorite_count: legacy.favorite_count || 0,
      retweet_count: legacy.retweet_count || 0,
      reply_count: legacy.reply_count || 0,
      quote_count: legacy.quote_count || 0,
      created_at: legacy.created_at || '',
      source: extractSource(legacy.source),
      hashtags: (legacy.entities?.hashtags || []).map(tag => tag.text).join(', '),
      urls,
      media_type: media.type,
      media_urls: media.urls,
      media_alt_texts: media.altTexts,
      article_title: article.title,
      article_url: article.url,
      article_text: article.text
    };
    Object.defineProperty(parsed, '_context_metric_presence', {
      enumerable: false,
      value: {
        view_count: result.views?.count !== undefined && result.views?.count !== null,
        bookmark_count: legacy.bookmark_count !== undefined && legacy.bookmark_count !== null,
        favorite_count: legacy.favorite_count !== undefined && legacy.favorite_count !== null,
        retweet_count: legacy.retweet_count !== undefined && legacy.retweet_count !== null,
        reply_count: legacy.reply_count !== undefined && legacy.reply_count !== null,
        quote_count: legacy.quote_count !== undefined && legacy.quote_count !== null
      }
    });
    if (quotedTweet) {
      parsed.quoted_post = {
        id: quotedTweet.id,
        type: quotedTweet.type,
        text: quotedTweet.text,
        tweet_url: quotedTweet.tweet_url,
        author_name: quotedTweet.author_name,
        author_username: quotedTweet.author_username,
        created_at: quotedTweet.created_at,
        media_type: quotedTweet.media_type,
        media_urls: quotedTweet.media_urls,
        media_alt_texts: quotedTweet.media_alt_texts,
        article_title: quotedTweet.article_title,
        article_url: quotedTweet.article_url,
        article_text: quotedTweet.article_text,
        view_count: quotedResult?.views?.count ?? '',
        bookmark_count: quotedLegacy.bookmark_count ?? '',
        favorite_count: quotedLegacy.favorite_count ?? '',
        retweet_count: quotedLegacy.retweet_count ?? '',
        reply_count: quotedLegacy.reply_count ?? '',
        quote_count: quotedLegacy.quote_count ?? ''
      };
    }
    return parsed;
  }

  function detectTweetType(legacy, result) {
    if (result.legacy?.retweeted_status_result || legacy.retweeted_status_result) return 'retweet';
    if (result.article?.article_results?.result) return 'article';
    if (legacy.in_reply_to_status_id_str) return 'reply';
    if (result.quoted_status_result) return 'quote';
    return 'tweet';
  }

  function extractArticle(result, authorUsername) {
    const article = result.article?.article_results?.result;
    if (!article) return { title: '', url: '', text: '' };
    const title = article.title || '';
    const text = article.plain_text || article.preview_text || '';
    const articleId = article.rest_id || article.id || '';
    let url = '';
    if (articleId && authorUsername) {
      url = `https://x.com/${authorUsername}/article/${articleId}`;
    } else if (result.legacy?.id_str && authorUsername) {
      url = `https://x.com/${authorUsername}/status/${result.legacy.id_str}`;
    }
    return { title, url, text };
  }

  function extractCardUrl(result) {
    const cardLegacy = result.card?.legacy;
    if (!cardLegacy) return '';
    const values = cardLegacy.binding_values;
    const lookup = (key) => {
      if (Array.isArray(values)) {
        return values.find(value => value?.key === key)?.value?.string_value || '';
      }
      return values?.[key]?.string_value || '';
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
    if (media.length === 0) return { type: '', urls: '', altTexts: '' };

    const types = new Set(media.map(item => item.type));
    let type = '';
    if (types.has('video')) type = 'video';
    else if (types.has('animated_gif')) type = 'animated_gif';
    else if (types.has('photo')) type = 'photo';

    const urls = media.map(item => {
      if (item.type === 'video' || item.type === 'animated_gif') {
        const variants = (item.video_info?.variants || [])
          .filter(variant => variant.content_type === 'video/mp4')
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (variants.length > 0) return variants[0].url;
      }
      return item.media_url_https || item.media_url || '';
    }).join(', ');
    const altTexts = media.some(item => item.ext_alt_text)
      ? media.map(item => item.ext_alt_text || '').join(' | ')
      : '';
    return { type, urls, altTexts };
  }

  globalThis.XPorterApiParsers = {
    parseFollowersResponse,
    parseUserObject,
    parseAboutAccountResponse,
    parseTimelineResponse,
    parseSearchTimelineResponse,
    parseBookmarksResponse,
    parseTweetResultsResponse,
    toPostContext: postContext,
    parseTweetObject
  };
})();
