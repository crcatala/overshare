# Self-hosting the viewer

The CLI links shares to the hosted viewer at <https://overshare.link/s/> by default. Run your own
copy if you want to own the code that renders what you share, or to read shares from your own R2 bucket.

## How it fits together

There is no backend and no auth. Shares are public-by-link files; the viewer is static
HTML/JS that fetches them in the browser. Self-hosting means forking this repo,
tweaking it, and deploying your own copy of the viewer — so you know exactly which code
renders what you share.

```
overshare publish ───upload───► gist  or  public R2 bucket   (your credentials, from your machine)
                                        ▲
viewer (static, any host) ──fetch───────┘  …/s/#owner/gistId  or  …/s/#r2:<id>
```

## Build-time config

`viewer.config.json` lists extra share sources as URL templates:

```json
{ "sources": { "r2": "https://shares.example.com/s/{id}.json" } }
```

The template must equal the CLI's `r2.publicUrl` + `r2.prefix` + `{id}.json`. Each
source's origin is added to the Content-Security-Policy; the viewer only ever fetches
from GitHub gist hosts and the sources you list. (`$OVERSHARE_VIEWER_CONFIG` points
the build at a different file.)

### Build output

`npm run build:viewer` (Vite) writes `viewer/dist/`: `s/` (the viewer, with relative asset URLs so
any base path works, and `s/font-licenses.txt` for its bundled fonts), `standalone.html` (the template for
[single-file HTML exports](sharing.md#single-file-html)), `_headers` (CSP with
`frame-ancestors 'none'`, `noindex`, `no-referrer`, `nosniff`), `_redirects`
(`/` → `/s/`) and `robots.txt`. Any static host works; Cloudflare reads
`_headers`/`_redirects` natively.

## Deploying to Cloudflare

`wrangler.jsonc` defines an assets-only Worker (no Worker code, no bindings):

```bash
npx wrangler login          # once
npm run deploy              # builds the viewer and the landing page, and deploys both
# → https://overshare-viewer.<your-subdomain>.workers.dev/   (landing page)
#   https://overshare-viewer.<your-subdomain>.workers.dev/s/ (viewer)
npm run preview:cf          # the same build, served locally by wrangler with the real headers
```

Custom domains (e.g. `agent.example.com`) are attached to the Worker in the Cloudflare
dashboard; nothing in this repo assumes a domain. Point the CLI at your copy by setting `viewerUrl`
(or `OVERSHARE_VIEWER_URL`) to wherever you deployed (`https://…/s/`); see [Configuration](configuration.md).

### Give the viewer an origin of its own

The viewer trusts everything on its own origin (scheme, host and port), so serve it from one that
hosts nothing but this build, e.g. a dedicated subdomain. A different path on a shared domain is not
enough:

- **Scripts:** the CSP allows `script-src 'self'`. Shares are untrusted, and that policy is what
  stops a sanitizer bypass from running code; if anyone can put a `.js` file on the origin (user
  uploads, another app, a bucket), it no longer would.
- **`#url:` links** load any same-origin path as a share, labelled "on this site". A JSON file someone
  else can place on the origin opens as if you had published it.
- **Fetches and images** from `'self'` are allowed, and the reader's view settings sit in that
  origin's `localStorage`, shared with anything else served there.

Your R2 share bucket can sit on a sibling subdomain (`shares.example.com` next to
`viewer.example.com`): the viewer only fetches from it, and its origin is added to `connect-src`.

## Example session

The build also writes an **example session** to `s/examples/session.json`, so every deployment
(and `overshare serve`, and the dev server) has a share to show without publishing anything:
open `…/s/#url:examples/session.json`. It is the fake Claude Code fixture session, run through
the real pipeline in `full` mode with its planted fake secrets, so it shows real
`[REDACTED:…]` replacements (`&turn=3` jumps to the redacted `env` output) and readers can
step down to every other mode. A fixed home, username and the default config make it the
same whoever builds it.

## The landing page

`site/` is the page at `/` (overshare.link's home page): static HTML, one stylesheet and one
small script, built by `vite.site.config.ts` into `viewer/dist/` next to the viewer
(`npm run build:site`, after `build:viewer`; `npm run dev:site` serves it on :3001 with
reload). Its "see an example" links open the example session above in the viewer.

With the landing page in the build, the deploy files change: `/` is served instead of
redirected to `/s/`, only `/s/*` carries `noindex` (and `robots.txt` disallows only `/s/`),
and each path gets its own Content-Security-Policy. The page's is same-origin only: no inline
code, no remote fonts (Bricolage Grotesque and the viewer's JetBrains Mono are self-hosted, with their OFL
licenses in `font-licenses.txt`). The npm
package ships the viewer build alone, without the landing page.

Deploying your own viewer without it: drop `npm run build:site` from the `deploy` script
(or delete `site/`), and `/` redirects to the viewer again.
