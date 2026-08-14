# Repository policy

- This directory's canonical GitHub repository is the public repository `https://github.com/Lemelson/xporter-extension`.
- Use `origin` for normal fetch, pull, and push operations. Do not push commits from this directory to `Lemelson/xporter`.
- The local `private-archive` remote exists only to preserve read-only access to the former private repository.
- Preserve unrelated worktree changes. Treat `manifest.json` and runtime source as product truth, `README.md` as user-facing documentation, `CLAUDE.md` as the quick orientation, and `agent.md` as the detailed architecture reference.
- `manifest.json` is the build-version source of truth. For a release, synchronize its version with the popup footer date and the localized three-entry “Last updates” history; do not rewrite historical versioned audit files.
- Keep `agent.md` and `CLAUDE.md` synchronized with new files, settings, messages, export modes, permissions, and script loading order. Keep claims in `README.md` within what the runtime and privacy policy actually support.
- Before committing runtime or documentation updates, run `node --test test-lab/tests/offline-lab.test.js`, `node test-lab/run.js --sample 5 --seed local-check`, `node scripts/test-static-contracts.js`, `node scripts/test-extension-core.js`, `node scripts/test-rate-limit.js`, `node scripts/test-feed-capture.js`, `node scripts/test-tooling-policy.js`, and `git diff --check`. Build release candidates only with `scripts/package.sh`.
- Deterministic tests do not prove that X's private endpoints, cookies, query IDs, or live payloads are still compatible. Record live-X and unpacked-browser verification separately.
- On macOS under `CODEX_SANDBOX`, never invoke bare `soffice` or `node scripts/test-extension-smoke.mjs`: full LibreOffice/Chromium app binaries abort during LaunchServices registration. Use `node scripts/soffice-headless.js ...` for XLSX checks. Run the Playwright smoke only through an approved unsandboxed exec (`sandbox_permissions=require_escalated`) or a normal Terminal session.
