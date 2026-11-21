# CLAUDE.md for pazka/pdf

A PDF editor that runs in the browser: change the text that is already in a PDF, add text, images
and shapes, download the result. Spec and roadmap: `BRIEF.md`.
Live at **https://pdf.hosh.it** on the owner's hosh.it box. **`docs/BOX-CONTRACT.md` is binding.**

| | |
|---|---|
| Image | `ghcr.io/pazka/pdf` |
| Host | `pdf.hosh.it` |
| Loopback port | `127.0.0.1:9143` → container port 8000 |
| Data | none on the server (no volume) |
| Env file on the box | `/srv/pdf/pdf.env` (no secret) |

## Product rules (owner decisions, do not undo)
- **The PDF never leaves the visitor's device** (owner, 2026-11-21: "browser only", which is why the
  site can stay public without any upload protection). The server is a static file server (`GET`/`HEAD`
  only). Do not add an API, uploads, accounts or sync without the owner asking for it explicitly.
- **The engine is MuPDF.js** (npm `mupdf`, AGPL-3.0-or-later; owner's choice, 2026-11-21). It is the
  only dependency. This repo is public and AGPL too, which is what the licence asks of a network service.
- **Changing a text really changes the file:** the old glyphs are removed from the page (a redaction
  without the black box), the new text is written in the same font. Never "cover with a white box"
  for a text edit.
- **Clicking a text is not an edit:** a text of the file that was clicked but not changed
  (`isPristine`) is a selection handle only. It is never drawn, saved or kept in the undo history,
  so the file keeps its own glyphs until the visitor really changes something.
- **What is shown is what is saved:** the page canvas is drawn by `engine.preview()`, which runs the
  same `bake()` as `engine.exportPdf()`. Do not draw objects another way on screen.
- **The opened file is never modified in memory:** every preview and every save starts from the
  original bytes plus the list of objects. Undo and redo are therefore only that list.
- **Fonts:** a PDF usually embeds only the glyphs it uses, so the editor writes with its own copy of
  the font, matched by name (`matchFont`), else the closest standard font, and says so in the panel.
  Shipped fonts live in `web/fonts/` with their licence and `SHA256SUMS`; adding a font family is a
  supply chain change (owner's yes).
- Never a CDN, analytics or third-party request: the CSP in `server/app.js` forbids them
  (`connect-src 'self'`, no inline script or style; `'wasm-unsafe-eval'` only compiles the MuPDF module).
- **Never commit a real document.** The only PDF in the repo is `visual/fixture.pdf`, built by
  `test/fixture.mjs`. Local trials go in `.testdata/` (ignored).

## Layout
- `web/`: the site as it is served (no bundler). `js/engine.js`: the edit engine, pure logic on
  MuPDF, no DOM (runs in Node for the tests). `js/app.js`: the editor (state, pointer and keyboard,
  panel). `css/app.css`, `fonts/`.
- `scripts/build.mjs`: `web/` + MuPDF.js from `node_modules` → `dist/`; `scripts/precompress.mjs`.
- `server/`: `main.js` (entry), `app.js` (headers, routes), `static.js` (prebuilt file map),
  `smoke.js` (POST_DEPLOY capability checks), `healthcheck.js`, `log.js`.
- `test/`: `npm test` (node:test): `engine.test.js`, `engine-files.test.js`, `engine-keeps.test.js`
  read every result back from the written PDF (extracted text, pixels); `server.test.js`,
  `log.test.js`. `test/fixture.mjs` builds the fixtures. `test/mutations.sh` breaks the engine one
  behaviour at a time: every line must say `killed` (MuPDF updates merge themselves on green CI,
  so what the tests do not pin can change unnoticed).
- `visual/`: visual regression harness and its use cases (`TESTING.md`).

## Rules
- Supply chain: every new third-party dependency needs the owner's explicit yes. `.npmrc`
  (ignore-scripts, save-exact, min-release-age=7) stays. Never install/build/test on the box.
  On the owner's laptop, installs and tests run inside the pinned Node container, never on the host.
- Every behaviour change gets a test that fails on the old code; an engine change is proven on the
  written file, not on the objects passed in.
- Deploying = cutting a release (Actions → release, `version=vX.Y.Z`); see `DEPLOY.md`.
- Never commit `*.env`.

## Agent system: QA gate, journal, "what happened to X"
**Before any work in this repo, whatever the request:** read the hub `pazka/hosh-management`:
`AGENTS.md` (how the hosh.it agents and the owner work together), `README.md` (every app, site, repo and
journal), `roles/` (the full procedure of each agent: QA, Security, Developer, DevOps, dependency updates).
`gh api repos/pazka/hosh-management/contents/AGENTS.md -H "Accept: application/vnd.github.raw"`
(same for `README.md`, `roles/README.md`, `roles/qa.md`...). Those rules apply here; this file adds the
repo's own.

Canonical rules: `AGENTS.md` in the private hub `pazka/hosh-management`
(`gh api repos/pazka/hosh-management/contents/AGENTS.md -H "Accept: application/vnd.github.raw"`).
Summary, binding for every agent that works in this repo:
- **Nothing is merged without the independent QA agent.** Work on `agent/<topic>-<yyyymmdd>`, get CI
  green, write in the PR body what changed, which use cases it touches and how it was tested, then add
  the label `qa:requested`. Merge only when the PR has `qa:approved` AND a comment
  `QA-VERDICT: APPROVED sha=<current head sha>`. On `qa:changes-requested`: fix on the same branch,
  answer each finding, ask again; QA re-tests the whole PR. Never approve your own PR. After QA's
  approval the agent that opened the PR merges it: this replaces "the owner merges" and "merge when
  CI is green" wherever this file still says so.
- **Owner fast lane**: when the owner asks for a feature in a session he is in, do it end to end in
  that session (discuss, develop, QA by a fresh independent QA subagent or a QA routine run now, merge,
  release, deploy, show the live URL). Rules: AGENTS.md section 2b. The session that wrote the code never
  writes the verdict.
- **QA owns the tests and the visual regression**: every use case a user can reach (listed in
  `TESTING.md`), screenshots at 1400 / 1024 / 390 px, baselines in the repo. A wanted visual change
  must be announced in the PR. Never weaken a test or a gate to get green.
- A NEW third-party dependency always needs the owner: open an issue in `pazka/hosh-management`
  labelled `ready-for-human` (that label is the list of places where the owner is needed).
- Release = Actions → release with `version=vX.Y.Z` on the default branch. Never push a git tag.
- **Journal**: after each event (PR ready, QA verdict, merge, release, deploy, rollback, incident,
  blocker) add one comment to this project's journal, `pazka/hosh-management#42`.
- **When the owner asks "what happened to X"** (this app, another one, or the server): open the index
  in `pazka/hosh-management` `README.md`, read the last comments of X's journal issue
  (`gh issue view <n> -R pazka/hosh-management --comments`), then the open `ready-for-human` issues,
  then PRs / Actions runs if needed. Server facts you cannot see: ask the Box agent (mailbox from a
  laptop session, or an issue labelled `box-question`). Answer with: what happened (dated), the state
  now, where the owner is needed.
- Online checks use only the URLs in `pazka/hosh-management` `uptime/checks.json`.
