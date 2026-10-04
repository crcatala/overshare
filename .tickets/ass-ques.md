---
id: ass-ques
status: in_progress
deps: []
links: []
created: 2026-10-04T17:36:14Z
type: feature
priority: 3
assignee: cc-vps
tags: [viewer, export, idea, needs-decision]
---
# Optional single-file HTML export (self-contained viewer + embedded session)

## Idea
pi's built-in `/share` publishes one self-contained HTML file (all CSS/JS inline, session embedded, no fetching). Offer the same as an optional output of agent-share: `agent-share export --format html -o session.html`, openable from disk, email, any static host, with no viewer deployment and no gist/R2 round trip. The current gist/R2 + hosted viewer flow stays the default.

## Feasibility (investigated 2026-10-04, see the PR for the prototype)
The viewer is already a static Vite bundle that only needs the session JSON, so this is mostly packaging:
1. Inline JS + CSS and base64 the fonts (`viewer/dist/session` is ~1.4 MB with source maps; ~0.25 MB JS+CSS, ~0.5 MB fonts).
2. Embed the share as `<script type="application/json">` and add an `embedded` viewer source that reads it instead of `fetch`.
3. Replace the CSP (it is `script-src 'self'`, which an inline bundle breaks) with a hash-based one.

## Gotchas / tradeoffs
- CSP: hash the inline script/style instead of `'unsafe-inline'`; `connect-src 'none'` (nothing to fetch). A meta tag is all a file on disk can have; a hosted copy can also send a header.
- Escaping: transcripts contain `</script>`, `<!--`, U+2028/9. Escape `<` in the embedded JSON and the same sequences in the inlined bundle. Splice the JSON in without `String.replace` (`$&` patterns).
- Viewer is frozen into every file: no later bug fixes for old shares; schema compat (`compat.ts`) only handles what the bundled viewer knows.
- No revocation: a copied file cannot be deleted like a gist/R2 object. The file holds the same redacted payload, but it is forwardable and indexable wherever it ends up.
- Size: fixed overhead ~1 MB (mostly base64 fonts) plus the session; `full` mode shares can be many MB and block first paint while parsing. Possible follow-ups: latin-only font subset flag, size warning.
- Gists cannot host it (raw is `text/plain`); R2 needs `content-type: text/html`. Hosting targets are out of scope for step 1.
- Share-menu links point at the file's own URL (`#&turn=N`), which only works where the file is hosted.
- `file://` has opaque origin; storage access differs by browser (viewer already guards it).

## Plan
1. (this ticket) Local-only `export --format html`: build-time standalone template, `embedded` source, CSP hashes, tests. Prototype for evaluation; may not be merged.
2. If kept: size policy/warnings, optional font subsetting, `publish --target r2 --format html`, `publish`/`browse` integration.

## Needs a decision before step 2
- Do we want a second shipping format at all, given the hosted viewer already gives updatable, revocable links?
- Fonts: full (current look everywhere) vs latin-only (about 300 KB smaller).

## Acceptance Criteria

export --format html writes one file with no external references (no src/href/url() to other files, no network requests when opened); opens and renders from file:// in Chromium with no CSP violations; embedded JSON survives </script>, <!-- and $& in transcripts; CSP hashes match the inline script/style; hosted viewer behaviour unchanged; npm test/typecheck/build pass


## Notes

**2026-10-04T17:42:13Z**

Step 1 prototyped on branch feat/single-file-html-export (PR pending): 'agent-share export --format html' (inferred from a .html output). Build writes viewer/dist/standalone.html (src/standalone.ts inlineViewer: JS+CSS inline, fonts as data URIs, CSP by sha256, connect-src 'none'); export splices the session in as <script type=application/json id=agent-share-session>; viewer gets an 'embedded' source that has no hash form. Verified in Chromium from file://: no console errors, no requests but the document, fetch() and an injected inline script are blocked by the CSP, view-mode switch, share menu and &turn= work. Sizes: template 0.9 MB (0.5 MB of that is fonts, base64 +33%); fixture session 52 KB -> 933 KB; 14 MB-transcript fixture (1,508 turns) 5.0 MB JSON -> 5.8 MB HTML, ~3.2 s to render in headless Chromium. Bug found while verifying: the bundle contains the text '</body>' (DOMPurify), so a first-match replace put the session inside the script; the inliner now splices by position in the original page. NOT done / open: font subsetting flag, size warning, publish --target r2 --format html, serving the CSP as a header, deciding whether to keep it (see 'Needs a decision').
