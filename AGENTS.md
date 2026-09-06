# Repository policy

- This directory's canonical GitHub repository is the public repository `https://github.com/Lemelson/xporter-extension`.
- Use `origin` for normal fetch, pull, and push operations. Do not push commits from this directory to `Lemelson/xporter`.
- The local `private-archive` remote exists only to preserve read-only access to the former private repository.
- Preserve unrelated worktree changes. Treat `manifest.json` and runtime source as product truth, `README.md` as user-facing documentation, `CLAUDE.md` as the quick orientation, and `agent.md` as the detailed architecture reference.
- `manifest.json` is the build-version source of truth. For a release, synchronize its version with the popup footer date and the localized three-entry “Last updates” history; do not rewrite historical versioned audit files.
- Keep `agent.md` and `CLAUDE.md` synchronized with new files, settings, messages, export modes, permissions, and script loading order. Keep claims in `README.md` within what the runtime and privacy policy actually support.
- `docs/` is the sole GitHub Pages source. Root copies of the site HTML and icons were removed; edit `docs/index.html`, `docs/privacy-policy.html`, `docs/feedback.html`, and `docs/assets/` directly.
- Keep `utils/capture-contract.js` before `content/interceptor.js` in MAIN and the generated `content/capture-prerequisites.js` before `content/content.js` in the isolated world. Regenerate the bundle with `node scripts/check-capture-bundle.js --write` after changing either canonical prerequisite; `test-all.js` checks freshness. Keep `background/export-policy.js` loaded before service-worker code consumes `XPorterExportPolicy`.
- Before committing runtime or documentation updates, run `node scripts/test-all.js` and `git diff --check`. Build release candidates only with `scripts/package.sh`, which runs the same deterministic gate plus `node scripts/test-xlsx-libreoffice.js` before atomically replacing its allowlist ZIP. The LibreOffice check is a strict integration gate; absence of the program is not a pass.
- Deterministic tests do not prove that X's private endpoints, cookies, query IDs, or live payloads are still compatible. Record live-X and unpacked-browser verification separately.
- On macOS under `CODEX_SANDBOX`, never invoke bare `soffice`; use `node scripts/soffice-headless.js ...`. Every Playwright entrypoint fails fast in the sandbox before loading a browser, so run smoke/layout/browser diagnostics only through an approved unsandboxed exec (`sandbox_permissions=require_escalated`) or a normal Terminal session.
