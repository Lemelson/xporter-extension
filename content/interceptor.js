// Runs in the x.com page context (registered in manifest.json in the
// MAIN world at document_start).
// Intercepts fetch/XHR to capture GraphQL queryIds for tracked operations
// and forwards them to the content script via window.postMessage.
(function () {
  // Guard against double installation (e.g. stale injection paths or
  // duplicate registration) — wrapping fetch/XHR twice would double-post.
  if (window.__XPORTER_INTERCEPTOR_INSTALLED__) return;
  window.__XPORTER_INTERCEPTOR_INSTALLED__ = true;

  const TRACKED = ['Followers', 'Following', 'BlueVerifiedFollowers', 'UserTweets', 'UserByScreenName', 'SearchTimeline'];
  const MAX_BODY_CHARS = 8 * 1024 * 1024; // must match content.js relay cap
  const MAX_FEED_BODY_CHARS = 2 * 1024 * 1024;
  const _origFetch = window.fetch;
  const _origXHROpen = XMLHttpRequest.prototype.open;

  function postQueryId(queryId, operationName) {
    window.postMessage({
      type: '__XPORTER_QUERYID__',
      queryId,
      operationName
    }, window.location.origin);
  }

  function postGraphqlResponse(operationName, url, status, bodyText) {
    // Cap relayed body size — drop oversized payloads entirely.
    if (typeof bodyText !== 'string' || bodyText.length > MAX_BODY_CHARS) return;
    window.postMessage({
      type: '__XPORTER_GRAPHQL_RESPONSE__',
      operationName,
      url,
      status,
      bodyText
    }, window.location.origin);
  }

  function postSeenPosts(operationName, bodyText) {
    try {
      if (!window.XPorterFeedParser?.supportsOperation(operationName)) return;
      const posts = window.XPorterFeedParser.extractPosts(bodyText);
      if (posts.length === 0) return;
      window.postMessage({
        type: '__XPORTER_SEEN_POSTS__',
        operationName,
        posts
      }, window.location.origin);
    } catch (e) { /* passive collection must never affect X */ }
  }

  function operationFromUrl(requestUrl) {
    if (!requestUrl || !requestUrl.includes('/i/api/graphql/')) return null;
    const match = requestUrl.match(/\/i\/api\/graphql\/([^/]+)\/([^?]+)/);
    if (!match) return null;
    return { queryId: match[1], operationName: match[2] };
  }

  window.fetch = async function (...args) {
    let operationName = null;
    let requestUrl = null;

    try {
      // Handles string, Request, and URL inputs.
      requestUrl = (typeof args[0] === 'string')
        ? args[0]
        : (args[0] instanceof Request ? args[0].url : String(args[0]));
      const operation = operationFromUrl(requestUrl);
      if (operation) {
        operationName = operation.operationName;
        if (TRACKED.includes(operationName)) {
          postQueryId(operation.queryId, operationName);
        }
      }
    } catch (e) { /* ignore */ }

    const response = await _origFetch.apply(this, args);

    try {
      const capturesExport = operationName === 'SearchTimeline';
      const capturesFeed = window.XPorterFeedParser?.supportsOperation(operationName);
      if ((capturesExport || capturesFeed) && response && response.status >= 200 && response.status < 300) {
        response.clone().text().then((bodyText) => {
          if (bodyText.length > MAX_BODY_CHARS) return;
          if (capturesExport) postGraphqlResponse(operationName, requestUrl, response.status, bodyText);
          if (capturesFeed && bodyText.length <= MAX_FEED_BODY_CHARS) {
            // Yield once so X can render the response before passive parsing.
            setTimeout(() => postSeenPosts(operationName, bodyText), 0);
          }
        }).catch(() => { });
      }
    } catch (e) { /* ignore */ }

    return response;
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      // Reset tracking on every open(): re-open() on the same XHR must not
      // inherit the previous request's operation name. The per-open token
      // invalidates any load listener from an earlier open() so a stale
      // listener can never mislabel this request's response.
      this.__xporterOperationName = null;
      this.__xporterRequestUrl = null;
      this.__xporterOpenToken = (this.__xporterOpenToken || 0) + 1;

      const requestUrl = String(url);
      const operation = operationFromUrl(requestUrl);
      if (operation) {
        const capturesExport = operation.operationName === 'SearchTimeline';
        const capturesFeed = window.XPorterFeedParser?.supportsOperation(operation.operationName);
        if (TRACKED.includes(operation.operationName)) {
          this.__xporterOperationName = operation.operationName;
          this.__xporterRequestUrl = requestUrl;
          postQueryId(operation.queryId, operation.operationName);
        }

        if (capturesExport || capturesFeed) {
          // Attach the load listener only for tracked URLs, bound to this open().
          const token = this.__xporterOpenToken;
          this.addEventListener('load', () => {
            try {
              if (this.__xporterOpenToken !== token) return; // re-opened since — stale
              if (this.status >= 200 && this.status < 300) {
                const bodyText = (this.responseType === '' || this.responseType === 'text') ? this.responseText : '';
                if (bodyText && bodyText.length <= MAX_BODY_CHARS) {
                  if (capturesExport) {
                    postGraphqlResponse(
                      operation.operationName,
                      this.responseURL || requestUrl,
                      this.status,
                      bodyText
                    );
                  }
                  if (capturesFeed && bodyText.length <= MAX_FEED_BODY_CHARS) {
                    setTimeout(() => postSeenPosts(operation.operationName, bodyText), 0);
                  }
                }
              }
            } catch (e) { /* ignore */ }
          }, { once: true });
        }
      }
    } catch (e) { /* ignore */ }

    return _origXHROpen.call(this, method, url, ...rest);
  };
})();
