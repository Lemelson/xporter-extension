# XPorter 1.4.8 deferred Computer Use verification

This checklist is intentionally deferred. The 1.4.8 code audit did not use Computer Use or browser automation.

Compare the unpacked 1.4.8 extension against 1.4.7 with an authenticated X account and record screenshots, downloaded artifacts, observed timings, and console/service-worker errors for every failure.

## Installation and migration

- Update an existing unpacked 1.4.7 installation to 1.4.8 and confirm settings, export history, seen-post data, theme, language, and any stopped/resumable export survive.
- Load 1.4.8 into a clean Chrome profile and confirm the popup opens without console or service-worker errors.
- Confirm the footer and `chrome.runtime.getManifest().version` show 1.4.8.

## Popup and settings

- Exercise dark/light switching, close/reopen the popup, and confirm the saved theme is restored without a flash or mismatched icon.
- Change every persisted setting, close/reopen, and confirm the displayed values match storage.
- Exercise all 14 languages, especially Arabic RTL, history cards, seen-post summaries, tooltips, status text, and quantity labels.
- Check keyboard navigation for tabs, the language selector, history controls, and focus restoration after the rating prompt.

## Standard export modes

- Run small Posts, Followers, Following, and Verified Followers exports with CSV, JSON, and XLSX output.
- Confirm item counts, cursor paging, deduplication, profile/status URLs, Unicode, long IDs, media alt text, Articles, and localized headers.
- Verify malformed/unavailable/private/suspended accounts surface the intended localized error and do not destroy the previous export.
- Start an export and press Stop while a network request is visibly in flight. It should stop promptly rather than wait for the network timeout.

## Resume and service-worker resilience

- Stop an export, change from one speed preset to another, Resume, and confirm the new pacing is actually used.
- Repeat with Custom speed and confirm the new delay, batch size, and cooldown all apply after Resume.
- Resume with “+N more”, terminate/reload the service worker before the first new page completes, reopen the popup, and confirm the raised per-export limit remains.
- Terminate the service worker during fetching, pacing, and a batch cooldown. Confirm the state becomes stopped/resumable with no missing or duplicate rows.
- Fill or deliberately fail extension storage in a test profile and confirm settings, clear/delete actions, and export state report an error instead of showing false success.

## Date-range capture

- Export a populated date range, a range with no posts, an open-ended range, and a range that reaches the quantity limit.
- Confirm the search tab opens in the foreground, overlay localization/progress/countdown works, Stop closes it, and the original tab is restored.
- Close the search tab manually, trigger X Retry/rate-limit states, and verify saved progress remains downloadable/resumable without fake completion.

## Downloads and retained data

- Open every generated CSV and XLSX in a spreadsheet application; validate ZIP/OOXML integrity, exact long IDs, Unicode, formula-injection protection, and column ordering.
- Download the current export, a history entry, and the seen-post database in every available format.
- Delete one history entry, clear all history, clear seen-post data, and test automatic expiry. The UI must change only after storage confirms success.
- Cancel a Chrome Save dialog and retry to confirm the popup does not get stuck disabled.

## Status, telemetry, and live X contracts

- Confirm toolbar badges for resolving/fetching counts, complete, stopped, and terminal error; reopening the popup should clear terminal badges.
- Inspect the uninstall URL locally and confirm it contains only documented anonymous fields, including `last_phase` and `first_item_ms`, with no username or exported content.
- Verify current live queryIds, feature flags, cookies, REST Followers response, GraphQL `timeline`/`timeline_v2`, SearchTimeline payloads, and rate-limit headers against authenticated X traffic.
- Test offline, slow-network, 401/403, 429, stale queryId, and malformed-response paths and compare the visible retry/terminal behavior with the 1.4.8 code contracts.
