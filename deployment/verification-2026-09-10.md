# Website verification — September 10, 2026

Scope: homepage, public privacy copy, search metadata, crawler references and
shared website assets. Based on `origin/main` at `b230b4c`. No extension runtime
or collector behavior changed.

## Confirmed locally

- `node scripts/test-all.js`: all 14 deterministic suites passed, including the
  new website suite. Generated-file freshness is part of the site check.
- `git diff --check`: passed.
- Sitemap XML parses and contains three public URLs: EN, RU and privacy.
- EN/RU have unique metadata, matching canonical URLs, reciprocal hreflang,
  valid JSON-LD, real installation links and no broken local resource links.
- The Open Graph image is a real PNG at the declared 1200 × 630 dimensions.
- Browser: EN → RU link navigation, RU → Japanese language selection, retained
  interface translations and explicitly English fallback text worked.
- Browser: light/dark theme toggles worked. The page retained its theme on reload.
- Responsive browser inspection covered 320, 390, 768 and 1280 CSS-pixel widths.
  A 320 px hero overflow was found and fixed; final document width at that size
  equals the viewport. The chart scrolls inside its own region on narrow screens.
- Historical chart: lazy loading showed 511 observed users, three model
  explanations and a 2,067 one-year scenario; switching the horizon and enabling
  the linear model changed the chart. The historical JSON was not modified.
- Separate local HTTP server used `Content-Security-Policy: script-src 'none'`.
  EN/RU page content, all eight FAQ answers, language links and installation
  links remained available. Controls needing scripts stayed hidden.
- Browser console had no errors in the normal page and chart flow.

## Verified against public services

The Store listing showed version 2.0.0, updated September 9, 2026. The live site
was inspected in the browser. The host-root robots file and project sitemap
returned 404. The Store homepage/privacy links still pointed to `/xporter/`.
Both old and canonical project homepages were reachable.

## Not established by these checks

These changes have not been published. Local checks do not establish Google or
Yandex indexing, AI citations, ranking changes, remote CI success or deployed
SHA/file parity. Host-root policy, old Store links, old-site canonicalization
and search-console submission are described in `SEO.md`.
