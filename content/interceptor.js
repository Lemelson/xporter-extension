// Runs in the x.com page context (registered in manifest.json in the
// MAIN world at document_start).
// Intercepts fetch/XHR to capture successful, sanitized native GraphQL request
// templates and forwards them to the content script via window.postMessage.
(function () {
  // Guard against double installation (e.g. stale injection paths or
  // duplicate registration) — wrapping fetch/XHR twice would double-post.
  if (window.__XPORTER_INTERCEPTOR_INSTALLED__) return;
  window.__XPORTER_INTERCEPTOR_INSTALLED__ = true;

  const CAPTURE_CONTRACT = globalThis.XPorterCaptureContract;
  const _origFetch = window.fetch;
  const _origXHROpen = XMLHttpRequest.prototype.open;

  // Readiness only: the probe never carries credentials or export data.
  window.addEventListener?.('message', event => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type !== '__XPORTER_CAPTURE_PROBE__' ||
        typeof event.data.nonce !== 'string' || event.data.nonce.length > 80) return;
    window.postMessage({ type: '__XPORTER_CAPTURE_READY__', nonce: event.data.nonce }, window.location.origin);
  });

  function postNativeTemplate(template) {
    if (!template) return;
    window.postMessage({
      type: '__XPORTER_NATIVE_REQUEST_TEMPLATE__',
      template
    }, window.location.origin);
  }

  // x-rate-limit-reset (unix seconds) lets the worker wait exactly until X's
  // window reopens after a 429. Only a plain positive integer is forwarded.
  function rateLimitResetFrom(status, readHeader) {
    if (status !== 429) return null;
    try {
      const raw = String(readHeader('x-rate-limit-reset') ?? '').trim();
      if (!/^\d{1,12}$/.test(raw)) return null;
      const seconds = Number(raw);
      return seconds > 0 ? seconds : null;
    } catch (e) {
      return null;
    }
  }

  function postGraphqlResponse(operationName, url, status, bodyText, error, rateLimitReset = null) {
    if (typeof bodyText !== 'string') return;
    // Report the reason without forwarding an oversized response body.
    if (bodyText.length > CAPTURE_CONTRACT.MAX_BODY_CHARS) {
      bodyText = '';
      error = 'SEARCH_RESPONSE_TOO_LARGE';
    }
    window.postMessage({
      type: '__XPORTER_GRAPHQL_RESPONSE__',
      operationName,
      url,
      status,
      bodyText,
      ...(rateLimitReset ? { rateLimitReset } : {}),
      ...(error ? { error } : {})
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

  // Date-range export captures SearchTimeline only in XPorter's own search
  // tab (always /search). Search responses can be megabytes; never clone and
  // relay them from ordinary X tabs (typeahead, other pages).
  function capturesSearchExport(operationName) {
    return operationName === 'SearchTimeline' && window.location?.pathname === '/search';
  }

  function operationFromUrl(requestUrl) {
    if (!requestUrl || !requestUrl.includes('/i/api/graphql/')) return null;
    const match = requestUrl.match(/\/i\/api\/graphql\/([^/]+)\/([^?]+)/);
    if (!match) return null;
    return { queryId: match[1], operationName: match[2] };
  }

  function absoluteRequestUrl(requestUrl) {
    // The worker validates URLs without a document base. Native fetch/XHR
    // callers may use relative URLs, including their failed-request paths.
    return new URL(requestUrl, window.location.href || window.location.origin).href;
  }

  window.fetch = async function (...args) {
    let operationName = null;
    let requestUrl = null;
    let nativeTemplate = null;

    try {
      // Handles string, Request, and URL inputs.
      requestUrl = (typeof args[0] === 'string')
        ? args[0]
        : (args[0] instanceof Request ? args[0].url : String(args[0]));
      requestUrl = absoluteRequestUrl(requestUrl);
      // Fetch init overrides the method stored in a Request object.
      const method = args[1]?.method ||
        (args[0] instanceof Request ? args[0].method : 'GET');
      const operation = operationFromUrl(requestUrl);
      if (operation) {
        operationName = operation.operationName;
        nativeTemplate = globalThis.XPorterNativeTemplate?.parseRequestUrl(requestUrl, method) || null;
      }
    } catch (e) { /* ignore */ }

    let response;
    try {
      response = await _origFetch.apply(this, args);
    } catch (error) {
      if (capturesSearchExport(operationName)) {
        postGraphqlResponse(operationName, requestUrl, 200, '', 'SEARCH_NETWORK_ERROR');
      }
      throw error;
    }

    try {
      const capturesExport = capturesSearchExport(operationName);
      const capturesFeed = window.XPorterFeedParser?.supportsOperation(operationName);
      const successful = response && response.status >= 200 && response.status < 300;
      if (successful && nativeTemplate) postNativeTemplate(nativeTemplate);
      // SearchTimeline errors are part of the export protocol: the worker uses
      // 429/4xx status codes to show a real countdown and decide whether to
      // retry. Feed collection remains success-only.
      if ((capturesExport || (capturesFeed && successful)) && response) {
        response.clone().text().then((bodyText) => {
          if (capturesExport) {
            postGraphqlResponse(operationName, requestUrl, response.status, bodyText, undefined,
              rateLimitResetFrom(response.status, name => response.headers?.get(name)));
          }
          if (capturesFeed && successful &&
              bodyText.length <= CAPTURE_CONTRACT.MAX_FEED_BODY_CHARS) {
            // Yield once so X can render the response before passive parsing.
            setTimeout(() => postSeenPosts(operationName, bodyText), 0);
          }
        }).catch(() => {
          if (capturesExport) postGraphqlResponse(operationName, requestUrl, response.status, '', 'SEARCH_NETWORK_ERROR');
        });
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
      this.__xporterNativeTemplate = null;
      this.__xporterOpenToken = (this.__xporterOpenToken || 0) + 1;

      const requestUrl = absoluteRequestUrl(String(url));
      const operation = operationFromUrl(requestUrl);
      if (operation) {
        const capturesExport = capturesSearchExport(operation.operationName);
        const capturesFeed = window.XPorterFeedParser?.supportsOperation(operation.operationName);
        const nativeTemplate =
          globalThis.XPorterNativeTemplate?.parseRequestUrl(requestUrl, method) || null;
        if (CAPTURE_CONTRACT.isTrackedOperation(operation.operationName)) {
          this.__xporterOperationName = operation.operationName;
          this.__xporterRequestUrl = requestUrl;
          this.__xporterNativeTemplate = nativeTemplate;
        }

        if (nativeTemplate || capturesExport || capturesFeed) {
          // Attach the load listener only for tracked URLs, bound to this open().
          const token = this.__xporterOpenToken;
          this.addEventListener('load', () => {
            try {
              if (this.__xporterOpenToken !== token) return; // re-opened since — stale
              const successful = this.status >= 200 && this.status < 300;
              if (successful && nativeTemplate) postNativeTemplate(nativeTemplate);
              if (capturesExport || (capturesFeed && successful)) {
                const bodyText = (this.responseType === '' || this.responseType === 'text') ? this.responseText : '';
                if (capturesExport || (bodyText && bodyText.length <= CAPTURE_CONTRACT.MAX_BODY_CHARS)) {
                  if (capturesExport) {
                    postGraphqlResponse(
                      operation.operationName,
                      absoluteRequestUrl(this.responseURL || requestUrl),
                      this.status,
                      bodyText,
                      undefined,
                      rateLimitResetFrom(this.status, name => this.getResponseHeader(name))
                    );
                  }
                  if (capturesFeed && successful &&
                      bodyText.length <= CAPTURE_CONTRACT.MAX_FEED_BODY_CHARS) {
                    setTimeout(() => postSeenPosts(operation.operationName, bodyText), 0);
                  }
                }
              }
            } catch (e) { /* ignore */ }
          }, { once: true });
          if (capturesExport) {
            // Mirror the fetch path: a transport failure must reach the worker
            // as SEARCH_NETWORK_ERROR instead of leaving the capture waiting.
            const reportFailure = () => {
              try {
                if (this.__xporterOpenToken !== token) return;
                postGraphqlResponse(operation.operationName, requestUrl, 200, '', 'SEARCH_NETWORK_ERROR');
              } catch (e) { /* ignore */ }
            };
            for (const type of ['error', 'abort', 'timeout']) {
              this.addEventListener(type, reportFailure, { once: true });
            }
          }
        }
      }
    } catch (e) { /* ignore */ }

    return _origXHROpen.call(this, method, url, ...rest);
  };
})();
