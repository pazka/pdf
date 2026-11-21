# Deploying pdf.hosh.it

Deployment on the hosh.it box (box standard: `docs/BOX-CONTRACT.md`). Releases deploy themselves
through **hosh-deploy** (§1); a first install is a one-time on-box registration (§1b), then the first
deploy itself also comes from GitHub Actions. `.env.example` defaults already fit the box, and there
is **no secret at all**: the app has no login and stores nothing. A PDF is opened, edited and saved
in the visitor's browser and never reaches the server.

## 1. How releases go live (hosh-deploy is the only deploy path on the box)

Every release (`release` workflow: Actions → release, `version=vX.Y.Z`) ends with the **`deploy`** job:
GitHub connects to the box as `deployer` with this repo's `HOSH_DEPLOY_KEY` (bound to pdf
only) and runs `hosh-deploy deploy pdf vX.Y.Z`. The box pulls the image, swaps the tag in
`pdf.env`, waits healthy, checks `/healthz` on the loopback port and through Traefik, runs
`POST_DEPLOY` inside the container (`deploy/hosh-deploy.conf`) and **rolls back by itself** if any
check fails (the workflow then goes red). Nothing from the repo runs on the host.

- Redeploy / roll forward / back: Actions → **deploy** → `vX.Y.Z`, `rollback` or `status`.
- On the box: `sudo hosh-deploy deploy pdf vX.Y.Z`, `sudo hosh-deploy rollback pdf`,
  `sudo hosh-deploy status pdf`. Log: `/var/log/hosh-deploy.log`.
- Repo variable `HOSH_AUTODEPLOY=false` stops auto-deploy after releases (manual dispatch still works).

## 1b. First install on the box (once; on-box Claude in an owner-opened sudo window)

Box rules: `ACTIONS-LOG.md` intent BEFORE, result + revert AFTER; `/home/pazka/MIGRATION/scripts/smoke.sh`
BEFORE and AFTER. Prerequisites: DNS `pdf.hosh.it` A → 54.37.70.57 (`scripts/dns-add.sh pdf`),
port 9143 in the registry of `11-BOX-STANDARD.md` (the repo was scaffolded on the owner's laptop
with 9143, the next free line of the registry on 2026-11-21: if the box gives another port, change
`APP_BIND` in `.env.example`, `BIND` in `deploy/hosh-deploy.conf` and the compose default through a
PR before registering), release `v0.1.0` built (image public on GHCR).

```sh
# A: release checkout (provides docker-compose.example.yml, .env.example, deploy/*)
sudo mkdir -p /srv/pdf && sudo chmod 750 /srv/pdf
sudo bash -c 'cd /srv/pdf && { [ -d .git ] || { git init -q && git remote add origin https://github.com/pazka/pdf; }; } && git fetch -q --depth 1 origin tag v0.1.0 && git checkout -q v0.1.0'
# B: env file from the template (no secret exists for this app)
sudo bash -c 'cd /srv/pdf && { [ -e pdf.env ] || install -m 600 .env.example pdf.env; }'
# C: (none: no owner secret)
# D: pin the box config (validates the compose hardening). NO deploy from the box: GitHub does it (F).
sudo hosh-deploy register pdf
# E: GitHub key for deploys (keygen; root binds the public half; gh stores the private half; shred)
ssh-keygen -q -t ed25519 -N '' -C hosh-deploy:pdf -f /tmp/pdf-deploy
sudo bash /home/pazka/MIGRATION/scripts/setup-hosh-deploy.sh key pdf /tmp/pdf-deploy.pub
gh secret set HOSH_DEPLOY_KEY -R pazka/pdf < /tmp/pdf-deploy && shred -u /tmp/pdf-deploy /tmp/pdf-deploy.pub
# F: first deploy = CI (owner rule): writes the Traefik route, runs POST_DEPLOY, rolls back by itself
gh workflow run deploy -R pazka/pdf -f version=v0.1.0
```
Then add `svc_pdf` to the box smoke harness (`scripts/smoke.sh`) from §3, `pdf.hosh.it`
in `TLS_HOSTS`, run `scripts/smoke.sh all` (AFTER), commit the route in `/root/hosh-deploy`, set the
registry line to `live`, and check Actions → deploy → `status`. The hub then gets `pdf.hosh.it` in
`uptime/checks.json` (`/healthz`, and `/` containing `<title>pdf.hosh.it`).

**Revert:** `cd /srv/pdf && sudo docker compose --env-file pdf.env down` +
`sudo rm /root/hosh-deploy/edge/traefik/dynamic/pdf.yml /etc/hosh-deploy/apps/pdf.conf` +
`sudo bash /home/pazka/MIGRATION/scripts/setup-hosh-deploy.sh unkey pdf` +
`gh secret delete HOSH_DEPLOY_KEY -R pazka/pdf` + `sudo rm -rf /srv/pdf`.
No volume to keep: the app has no server-side data.

## 2. Variables (`pdf.env`, mode 600)
| Variable | Default | Set by | Meaning |
|---|---|---|---|
| `APP_IMAGE` | `ghcr.io/pazka/pdf:v0.1.0` | hosh-deploy | Release tag running (the only line hosh-deploy rewrites). |
| `APP_BIND` | `127.0.0.1:9143` | template | Loopback port published for Traefik. |
| `APP_LOG_LEVEL` | `info` | template | `debug`, `info`, `warn`, `error` (JSON lines, TESTING.md "Logs"). |
| `APP_PORT` | `8000` (unset) | n/a | Listening port inside the container; leave unset. |
| `APP_STATIC_DIR` | `/app/dist` (unset) | n/a | Built front-end; leave unset. |

## 3. Capability checks (what "works" means, beyond a 200)
All run by **`/nodejs/bin/node /app/server/smoke.js http://127.0.0.1:8000`** inside the container
(`POST_DEPLOY` after every deploy; non-zero ⇒ automatic rollback) and in CI against the hardened container.

| Feature | Request → expected |
|---|---|
| Health | `GET /healthz` → 200 `{"status":"ok","index":true,"engine":true,"fonts":4,"files":~15,…}` |
| Page + CSP | `GET /` → 200 HTML containing `<title>pdf.hosh.it`, CSP `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; … frame-ancestors 'none'`, `nosniff`, no inline script or style, no absolute URL (no CDN) |
| Editor | `/js/app.js`, `/js/engine.js`, `/css/app.css` → 200, `Content-Encoding: br`, `Cache-Control: no-cache` |
| PDF engine | `/vendor/mupdf/mupdf-wasm.wasm` → 200 `application/wasm`, more than 5 MB, starts with `00 61 73 6d`; `/vendor/mupdf/mupdf.js` → 200 |
| Fonts | `/fonts/Lato-Regular.ttf` → 200 `font/ttf`; `/fonts/` → 404 (no listing) |
| Dotfiles/sources | `/.env`, `/.git/config`, `/server/main.js`, `/package.json` → 404 |
| Read-only | `POST`/`PUT`/`DELETE /` → 405 (the server accepts no data) |
| Browser (manual) | open https://pdf.hosh.it, open a PDF, click a text, change it, Download: the downloaded file has the new text; DevTools shows no CSP error and no request after the page has loaded |

## 4. What runs
| Item | Value |
|---|---|
| Image | `ghcr.io/pazka/pdf:vX.Y.Z` (distroless Node 26, uid 10001) |
| Upstream | container :8000 → `127.0.0.1:9143` |
| Edge | `/root/hosh-deploy/edge/traefik/dynamic/pdf.yml` (router `pdf@file`, resolver `le`, HSTS) |
| Volume | none (stateless) |
| Health | `GET /healthz` → `{"status":"ok", …}` |
| Outbound | none |
| Memory | `mem_limit: 256m` (static files only; the PDF work happens in the visitor's browser) |

## 5. Decisions / known limits
- **Browser only, public, no login (owner decision, 2026-11-21).** The owner chose the browser engine
  so that nobody can upload a file to the box. The server answers `GET`/`HEAD` only, and the CSP's
  `connect-src 'self'` (plus no API on the server) means the page cannot send a PDF anywhere.
- **Runtime least privilege:** Node's permission model, `--permission --allow-fs-read=/app/ --allow-net`
  (network: Node 25+ gates sockets too, and the server must listen): no file writes, no child
  processes, no workers, no native addons, no env file read. The file list is read once at start-up
  and requests are looked up in it, so traversal and dotfiles are impossible by construction. No
  outbound connection is ever made.
- **No CDN:** MuPDF.js (JavaScript + WebAssembly) and the fonts are served by the app itself.
  `'wasm-unsafe-eval'` in the CSP lets the page compile that WebAssembly module; it does not allow `eval`.
- **Caching:** file names carry no hash (no bundler), so every file is served `no-cache` with an
  ETag: the browser revalidates (304) and a new release is seen at once. The 10 MB WebAssembly
  module travels once (3.6 MB in brotli), then costs one 304 per visit.
- **Supply chain:** one dependency, `mupdf` (Artifex, AGPL-3.0-or-later, no dependency of its own),
  copied into the front-end at build time; the server uses only Node's standard library. Exact pin,
  frozen lockfile, `ignore-scripts`, `min-release-age=7`, Dependabot with a 7-day cooldown, base
  images pinned by digest. The Lato font files are committed with their SHA-256 (`web/fonts/SHA256SUMS`).
- **Licence:** MuPDF is AGPL, so this repository is public and AGPL-3.0-or-later too (`README.md`).
