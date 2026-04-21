// Injected into the x.com page context by content.js.
// Intercepts fetch/XHR to capture GraphQL queryIds for tracked operations
// and forwards them to the content script via window.postMessage.
(function () {
  const TRACKED = ['Followers', 'Following', 'BlueVerifiedFollowers', 'UserTweets', 'UserByScreenName', 'SearchTimeline'];
  const _origFetch = window.fetch;
  const _origXHROpen = XMLHttpRequest.prototype.open;

  function postQueryId(queryId, operationName) {
    window.postMessage({
      type: '__XPORTER_QUERYID__',
      queryId,
      operationName
    }, '*');
  }

  function postGraphqlResponse(operationName, url, status, bodyText) {
    window.postMessage({
      type: '__XPORTER_GRAPHQL_RESPONSE__',
      operationName,
      url,
      status,
      bodyText
    }, '*');
  }

  window.fetch = async function (...args) {
    let operationName = null;
    let requestUrl = null;

    try {
      requestUrl = (typeof args[0] === 'string') ? args[0] : args[0]?.url;
      if (requestUrl && requestUrl.includes('/i/api/graphql/')) {
        const match = requestUrl.match(/\/i\/api\/graphql\/([^/]+)\/([^?]+)/);
        if (match && TRACKED.includes(match[2])) {
          operationName = match[2];
          postQueryId(match[1], operationName);
        }
      }
    } catch (e) { /* ignore */ }

    const response = await _origFetch.apply(this, args);

    try {
      if (operationName === 'SearchTimeline' && response?.ok) {
        response.clone().text().then((bodyText) => {
          postGraphqlResponse(operationName, requestUrl, response.status, bodyText);
        }).catch(() => { });
      }
    } catch (e) { /* ignore */ }

    return response;
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (typeof url === 'string' && url.includes('/i/api/graphql/')) {
        const match = url.match(/\/i\/api\/graphql\/([^/]+)\/([^?]+)/);
        if (match && TRACKED.includes(match[2])) {
          this.__xporterOperationName = match[2];
          this.__xporterRequestUrl = url;
          postQueryId(match[1], match[2]);
        }
      }
    } catch (e) { /* ignore */ }

    this.addEventListener('load', () => {
      try {
        if (this.__xporterOperationName === 'SearchTimeline' && this.status >= 200 && this.status < 300) {
          const bodyText = (this.responseType === '' || this.responseType === 'text') ? this.responseText : '';
          if (bodyText) {
            postGraphqlResponse(
              this.__xporterOperationName,
              this.responseURL || this.__xporterRequestUrl,
              this.status,
              bodyText
            );
          }
        }
      } catch (e) { /* ignore */ }
    }, { once: true });

    return _origXHROpen.call(this, method, url, ...rest);
  };
})();
