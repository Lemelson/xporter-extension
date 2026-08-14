# XPorter Offline Test Lab

This folder runs XPorter's current production parser, API client, and export
formatters from the terminal. It does not copy those algorithms and it is not
listed in `manifest.json`.

The lab has twenty synthetic profiles with different languages and edge cases.
By default it chooses five profiles with a reproducible seed, serves
REST/GraphQL-shaped responses without internet access, and checks:

- 50 unique Posts and 50 Posts + 10 linked Replies per profile;
- 50 unique Followers, Following, and Verified Followers per profile;
- deduplication and normalized row counts;
- valid timestamps and reply-to relationships;
- CSV, JSON, XLSX, and posts TXT generation, including every exported ID;
- profile-level `About this Account` data in Posts TXT/XLSX.

## Run

From the extension root:

```bash
node --test test-lab/tests/offline-lab.test.js
node test-lab/run.js --sample 5 --seed 2026-07-28
```

Run every prepared profile:

```bash
node test-lab/run.js --all --seed full
```

Each run writes inspectable files and a `summary.json` under
`test-lab/output/`. That directory is git-ignored.

## What is linked

`lib/production-runtime.js` reads these extension files from their real paths on
every run:

- `utils/config.js`
- `utils/api-features.js`
- `utils/api-parsers.js`
- `utils/native-request-template.js`
- `utils/api.js`
- `utils/columns-i18n.js`
- `utils/csv.js`

The summary records a SHA-256 hash for every loaded source. If production code
changes, the next lab run automatically tests the changed code.

## Confidence boundary

A green lab run proves the deterministic core from X-shaped HTTP responses
through exported file bytes. It does not prove that X still exposes the same
private endpoint/query shape, that an authenticated session is valid, that
Chrome permissions are correct, or that popup/content-script wiring works.

Use the lab for fast everyday regression checks. Keep one small unpacked-browser
smoke test for DOM, Chrome API, and live-X compatibility.
