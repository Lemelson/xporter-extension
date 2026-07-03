// XPorter — passive feed parser (MAIN world)
// Extracts compact post records from GraphQL responses already loaded by X.
(function () {
  const POST_OPERATION = /(Timeline|Tweets|TweetDetail|Bookmarks|Likes|Community|ListLatest|UserMedia)/i;
  const MAX_POSTS_PER_RESPONSE = 250;

  function supportsOperation(operationName) {
    return typeof operationName === 'string' && POST_OPERATION.test(operationName);
  }

  function unwrapTweet(result) {
    if (result?.__typename === 'TweetWithVisibilityResults') return result.tweet;
    return result;
  }

  function toCount(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
  }

  function parseTweet(result, options = {}) {
    result = unwrapTweet(result);
    const retweetedResult = result?.legacy?.retweeted_status_result?.result
      || result?.retweeted_status_result?.result;
    if (retweetedResult) {
      result = unwrapTweet(retweetedResult);
      options = { ...options, isRetweet: true };
    }
    const legacy = result?.legacy;
    if (!legacy?.id_str || legacy.in_reply_to_status_id_str) return null;

    const user = result.core?.user_results?.result;
    const userLegacy = user?.legacy || {};
    const userCore = user?.core || {};
    const username = userCore.screen_name || userLegacy.screen_name || '';
    const text = result.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || '';
    const media = legacy.extended_entities?.media || legacy.entities?.media || [];

    return {
      id: legacy.id_str,
      text,
      tweet_url: username ? `https://x.com/${username}/status/${legacy.id_str}` : '',
      language: legacy.lang || '',
      created_at: legacy.created_at || '',
      author_id: user?.rest_id || '',
      author_name: userCore.name || userLegacy.name || '',
      author_username: username,
      author_followers_count: toCount(userLegacy.followers_count),
      author_verified: Boolean(user?.is_blue_verified || userLegacy.verified),
      view_count: toCount(result.views?.count),
      bookmark_count: toCount(legacy.bookmark_count),
      favorite_count: toCount(legacy.favorite_count),
      retweet_count: toCount(legacy.retweet_count),
      reply_count: toCount(legacy.reply_count),
      quote_count: toCount(legacy.quote_count),
      is_quote: Boolean(result.quoted_status_result),
      is_retweet: Boolean(options.isRetweet),
      media_count: media.length,
      media_types: [...new Set(media.map(item => item?.type).filter(Boolean))].join(',')
    };
  }

  function extractPosts(bodyText) {
    if (typeof bodyText === 'string' && !bodyText.includes('"tweet_results"')) return [];
    let root;
    try {
      root = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
    } catch (_) {
      return [];
    }

    const posts = [];
    const seen = new Set();
    const stack = [root];

    while (stack.length && posts.length < MAX_POSTS_PER_RESPONSE) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;

      if (Array.isArray(node)) {
        for (let index = node.length - 1; index >= 0; index -= 1) {
          stack.push(node[index]);
        }
        continue;
      }

      const result = node.tweet_results?.result;
      if (result) {
        const post = parseTweet(result);
        if (post && !seen.has(post.id) && posts.length < MAX_POSTS_PER_RESPONSE) {
          seen.add(post.id);
          posts.push(post);
        }
        const visibleResult = unwrapTweet(
          unwrapTweet(result)?.legacy?.retweeted_status_result?.result
          || unwrapTweet(result)?.retweeted_status_result?.result
          || result
        );
        const quotedPost = parseTweet(visibleResult?.quoted_status_result?.result);
        if (quotedPost && !seen.has(quotedPost.id) && posts.length < MAX_POSTS_PER_RESPONSE) {
          seen.add(quotedPost.id);
          posts.push(quotedPost);
        }
      }

      for (const [key, value] of Object.entries(node)) {
        // Nested tweet payloads are handled explicitly above so the visible
        // retweet is canonicalized and an embedded quote is counted once.
        if (key === 'quoted_status_result' || key === 'retweeted_status_result' || key === 'tweet_results') {
          continue;
        }
        if (value && typeof value === 'object') stack.push(value);
      }
    }

    return posts;
  }

  window.XPorterFeedParser = {
    supportsOperation,
    extractPosts,
    parseTweet
  };
})();
