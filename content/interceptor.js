// Injected into the x.com page context by content.js.
// Intercepts fetch() to capture GraphQL queryIds for tracked operations
// and forwards them to the content script via window.postMessage.
(function () {
  const TRACKED = ['Followers', 'Following', 'BlueVerifiedFollowers', 'UserTweets', 'UserByScreenName'];
  const _origFetch = window.fetch;

  window.fetch = function (...args) {
    try {
      const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url;
      if (url && url.includes('/i/api/graphql/')) {
        const match = url.match(/\/i\/api\/graphql\/([^/]+)\/([^?]+)/);
        if (match && TRACKED.includes(match[2])) {
          window.postMessage({
            type: '__XPORTER_QUERYID__',
            queryId: match[1],
            operationName: match[2]
          }, '*');
        }
      }
    } catch (e) { /* ignore */ }
    return _origFetch.apply(this, args);
  };
})();
