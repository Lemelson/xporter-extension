# XPorter 1.5.9 — withdrawn

**Build date:** August 15, 2026

**Status:** Withdrawn on August 16, 2026

**Recommendation:** Do not install or use this version.

XPorter 1.5.9 was an experimental release. It was withdrawn after its required
permission change disabled existing installations pending user approval and
after large exports proved less dependable against X's private timeline
endpoints. XPorter 1.6.0 returns to the stable 1.5.8 code line.

## Why 1.5.9 is not recommended

### The update could disable the extension

Version 1.5.9 added one new required host permission:

```json
"https://pbs.twimg.com/*"
```

The existing named permissions did not change. The new host access was used
only by the optional **Embed photos in XLSX** feature: when enabled, XPorter
downloaded public post images without cookies and placed them on a separate
Media worksheet.

Although photo embedding was off by default, the host permission was declared
as required. Chrome evaluates required permissions at update time, not when a
feature is used. The update could therefore disable XPorter for every existing
user until that user accepted the new access.

This permission should have been declared in `optional_host_permissions` and
requested from a user gesture only when photo embedding was enabled. Declining
that optional request should leave ordinary exports and URL-only XLSX output
fully functional.

Chrome documents that a required permission increase can disable an extension
until the user accepts it, while adding an optional permission does not disable
the extension:

- [Permission warning guidelines](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)
- [Chrome permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)

### Recovery after a corrective update

A corrective update without the required `pbs.twimg.com` access can recover
installations that Chrome disabled only because of the 1.5.9 permission
increase. Chromium removes the `DISABLE_PERMISSIONS_INCREASE` reason when the
new package is no longer a privilege increase and enables the extension when
no other disable reason remains.

This does not reinstall copies that users removed, and it does not override a
separate manual disable action. Those users must install or enable XPorter
themselves. The relevant Chromium behavior is visible in the
[extension registrar source](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/chrome_extension_registrar_delegate.cc).

### Large exports were not dependable

Do not rely on 1.5.9 for large Posts or Bookmarks exports. In real-world use,
exports were reported to hit X rate limits or finish after only hundreds of
rows instead of reaching the amount previously available.

The packaged 1.5.9 build also replaced the simple **Include replies** switch
with experimental **All** and **Posts** profile-feed choices, introduced a new
`UserOriginalsTimeline` path, and removed the visible 5,000 and 10,000 quantity
presets. `Unlimited` still meant no local XPorter quantity cap; it did not
guarantee 3,200 rows.

For an existing 1.5.8 installation, a saved `includeReplies: false` selection
was migrated to **Posts** and therefore moved from `UserTweets` to the new
`UserOriginalsTimeline` operation. New installs defaulted to **All**, which used
`UserTweets` with replies and thread context. The packaged fallback query IDs
for `UserTweets` and `UserTweetsAndReplies` also changed.

These endpoint and migration changes are the strongest code-level candidates
for the observed difference in available rows: an unsupported or rotated
operation can return no continuation cursor and make the generic loop report
`source_exhausted`. Dynamic request capture and discovery normally take
priority over fallback IDs, however, so the artifacts alone do not prove which
endpoint response each affected user received.

XPorter uses X's private browser GraphQL timelines. X may return fewer rows,
omit a continuation cursor, change an operation, or rate-limit requests.
Therefore, the approximately 3,200-post figure is an upstream availability
reference, not a promise and not a hard-coded XPorter limit.

Photo-enabled XLSX downloads had a separate 250-row workbook part size. That
could create several small files, but it did not reduce the number of rows
collected. CSV, JSON, TXT, and XLSX without embedded photos retained their
ordinary download-part limits.

The release artifacts do not provide a deterministic live-X reproduction that
isolates one code change as the sole cause of every short export. The observed
production behavior, the experimental endpoint changes, and the permission
incident are sufficient reasons to keep 1.5.9 withdrawn.

## What was added in 1.5.9

- Personal Bookmarks export to CSV, JSON, XLSX, and TXT.
- Bookmark reply-parent enrichment through additional batched X requests.
- Article, quoted-post, and replied-to-post context in post-shaped exports.
- Optional XLSX photo embedding with a separate Media worksheet.
- Compact JSON output and omission of columns that were empty throughout a
  generated CSV or XLSX file.
- Clearer TXT ownership labels for nested post metrics and context.
- Current signed-in X account detection for viewer-owned Bookmarks.
- Experimental profile-feed selection and request-template capture.
- Richer public **About this Account** fields for user-list exports.
- Additional pacing, retry, resume, acknowledgement, UI, localization, and
  offline-test work.

## Safe design for a future photo-embedding feature

Photo embedding can return without disabling existing installations:

1. Put `https://pbs.twimg.com/*` in `optional_host_permissions`, not
   `host_permissions`.
2. Request it with `chrome.permissions.request()` only from the user's click on
   **Embed photos in XLSX** or the matching download action.
3. Check the grant with `chrome.permissions.contains()` before fetching.
4. If access is denied, keep media URLs in the workbook and explain that the
   images were not embedded.
5. Test an old-to-new packaged update before publishing and use a staged Web
   Store rollout for any future permission change.

## Artifact record

- Initial 1.5.9 source commit:
  `805520dacd7e4c02b9dde02356e7dddc698860ce`
- The packaged ZIP is not byte-identical to that commit. It was built from a
  later uncommitted working state that also contained the **All / Posts**
  profile-feed redesign and `UserOriginalsTimeline`.
- Withdrawn package: `xporter-v1.5.9.zip`
- Package SHA-256:
  `34ff063b0c1851ba47cbd0bb1434ee82c905eb2197793c312fcde44c8d4cf906`
- Stable rollback package: `xporter-v1.5.8.zip`
- Stable package SHA-256:
  `92984a268986d6607e6ffc94eed2c54fe590c578f76420d1a28ab6b9acc56612`
