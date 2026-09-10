# XPorter website maintenance and indexing

The site is served from `docs/` by the existing GitHub Pages workflow.
Canonical home: https://lemelson.github.io/xporter-extension/
Russian home: https://lemelson.github.io/xporter-extension/ru/

## Editing and checking

Edit `scripts/site/home.html`, `content.json`, `translations.json`, `site.css`,
`details.css` and `site.js`. `content.json` is the reviewed EN/RU product copy.
`translations.json` preserves the existing interface translations. New sections
without a translation use explicitly marked English text. EN/RU URLs serve complete
HTML and do not change language based on browser settings or saved preferences.

Run:

```sh
node scripts/build-site.cjs
node scripts/build-site.cjs --check
node scripts/test-site.cjs
node scripts/test-all.js
git diff --check
```

Commit generated pages and assets with their sources. The Pages workflow uploads
`docs/` directly. It does not need a Node runtime to serve the website.
Feedback logic, the collector, extension source and the extension version are
independent of this site update.

The two homepages have unique titles, descriptions, canonical URLs, reciprocal
EN/RU/x-default alternates, SoftwareApplication/WebSite/WebPage JSON-LD and a
1200 × 630 Open Graph/Twitter preview. There are no fabricated ratings or reviews.
Installation links and all main content work without JavaScript. FAQ and privacy details use native disclosures and work without scripts. The
historical chart remains inside a collapsed archive and loads when approached. Manrope is self-hosted under SIL OFL 1.1; the
font files and license are in `docs/assets/fonts/`.
The hero uses local interface screenshots (`assets/xporter-dark.png` and
`assets/xporter-light.png`) with an example profile, captured during the September
9 interface review. The caption identifies the example; the file card is an
illustration, not a live collection result. The screenshot follows the site theme.

The social image has an editable source at `scripts/site/social-preview.svg`.
After editing it, render `docs/assets/social-preview.png` at 1200 × 630, for
example with `rsvg-convert -o docs/assets/social-preview.png scripts/site/social-preview.svg`.

`llms.txt` is an optional discovery index. `llms-full.txt` is generated from the
same product facts as the visible page. These are useful text references, not
guaranteed indexing or ranking mechanisms. No alternate content is served based
on user agent. No special “AI schema” or keyword-stuffed pages are used.

## Product truth checked on September 10, 2026

- The live Store listing showed version 2.0.0, updated September 9, 2026.
- The local 2.0.0 runtime and privacy policy were used to check capabilities.
- Public `origin/main` reported 1.6.5. Do not automatically copy that number into
  the site or imply that the Store package and repository main are identical.
- The homepage's previous growth data ended July 16, 2026 (511 weekly users).
  It remains an explicitly dated archive. Forecasts are scenarios, not current
  usage or confidence intervals. No newer time series was invented.
- The Store listing still linked to `/xporter/` for its homepage and privacy
  policy. Both `/xporter/` and `/xporter-extension/` responded with a homepage.

## Steps requiring publication or host/account access

1. Publish this site's reviewed changes through the canonical repository and its
   existing Pages workflow. Check the deployed SHA and the actual public files.
2. The crawler control file MUST be at `https://lemelson.github.io/robots.txt`.
   A file at `/xporter-extension/robots.txt` is not authoritative. The host-root
   file returned 404 when checked. That does not itself block crawling.
   `deployment/robots-root.txt` is an additive sitemap directive for the host-root
   site (usually `Lemelson/lemelson.github.io`). Merge it with any existing policy;
   do not replace rules for other projects. A user agent needs its applicable
   group to permit this site's pages and assets. There is no need to repeat
   permissive wildcard rules for every named crawler.
3. Update the Chrome Web Store homepage and privacy links to the canonical
   `/xporter-extension/` URLs. Coordinate the old `/xporter/` host source: redirect
   public marketing pages to their matching canonical pages where the host
   supports it, or add corresponding canonical tags. Preserve working uninstall
   feedback URLs and query payloads; do not blanket-redirect the old project.
4. Submit `https://lemelson.github.io/xporter-extension/sitemap.xml` in Google
   Search Console and Yandex Webmaster after publication. Preserve the existing
   Google verification token/file. Add a Yandex verification token only when the
   property supplies a real one. Use their URL inspection tools to request
   recrawling of EN/RU and privacy pages; no obsolete sitemap “ping” requests.
5. Check the public HTML, robots root, sitemap, language alternates, image,
   Markdown files and 404 status after deployment. `feedback.html` remains
   crawlable with `noindex, follow` so crawlers can read that directive; it is
   intentionally absent from the sitemap. Do not disallow it in robots.txt and
   expect crawlers to discover noindex.

Indexing, search positions and inclusion in AI answers are outcomes to observe
after publication; local tests cannot establish them.

## References checked for this update

- [Google: AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
- [Google: structured data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
- [Yandex: robots.txt](https://yandex.ru/support/webmaster/ru/controlling-robot/robots-txt)
- [Yandex: canonical URLs](https://yandex.ru/support/webmaster/ru/robot-workings/canonical)
- [Yandex: sitemap submission](https://yandex.ru/support/webmaster/ru/indexing-options/sitemap)
- [OpenAI: crawlers, search and training controls](https://developers.openai.com/api/docs/bots)

Google Search's AI features use its ordinary indexing requirements. OAI-SearchBot
controls ChatGPT search crawling; GPTBot concerns model-training crawling. The
two purposes are separate. This update does not change the shared host's policy.
