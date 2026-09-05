# Search completion fixtures

`search-endings.synthetic.json` contains constructed regression cases, not captured X responses. It checks that missing cursors, partial instruction sets and alerts cannot become successful empty exports. Only an explicit `TimelineTerminateTimeline` with `direction: Bottom`, in an otherwise valid error-free response, is currently accepted as terminal.

Live protocol compatibility remains unverified. In particular, this policy may leave a genuinely finished search with `SEARCH_END_UNCONFIRMED` if X omits an explicit terminal marker. Saved rows remain downloadable. Do not reintroduce absence-of-cursor or date-coverage completion merely to hide that state.

Before release, obtain redacted responses from an authorized ordinary browser session for: a confirmed empty Latest search, a final page of a nonempty search, a continuing page, and `TimelineShowAlert` (including any accompanying entries). Preserve instruction types, ordering, cursor structure, error shape and response status; remove credentials, request headers, account identifiers and post content. Record observed UI state and capture date alongside each fixture. Do not label constructed or third-party examples as live captures. Add a protocol-specific terminal rule only when these responses support it.
