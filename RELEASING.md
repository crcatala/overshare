# Releasing

overshare ships as two things that are released separately:

- **The npm package** (`overshare`): the CLI, plus the viewer build used by `overshare serve` and
  single-file HTML exports. Released with [release-it](https://github.com/release-it/release-it),
  wrapped by `scripts/release.mjs`, from a maintainer machine.
- **The hosted viewer and landing page** at <https://overshare.link>: deployed to Cloudflare with
  `npm run deploy`. Every share link opens in it, so it must be live before anyone publishes.

Releases are cut by hand from a clean `main`. One command bumps the version, moves the changelog's
Unreleased section into the new version, commits, tags `vX.Y.Z`, pushes, creates the GitHub Release,
and only then publishes `overshare` to npm from the tagged commit.

## Prerequisites

- Push access to `crcatala/overshare` and a clean checkout of `main`. release-it pushes the release
  commit and tag straight to `main`, so if `main` is protected, allow yourself to bypass the rule.
- An npm account with publish rights to `overshare` (`npm whoami`), with two-factor auth set up
- A GitHub token in `GITHUB_TOKEN` with **Contents: read and write** on the repository, so
  release-it can create the GitHub Release (without one it opens the release form in the browser)
- Node.js `^22.22.2 || ^24.15.0 || >=26` (release-it's requirement; users only need 22.19)
- For viewer deploys: `npx wrangler login` with access to the Cloudflare account that serves
  overshare.link

## Before releasing

1. Update `main`:

   ```bash
   git checkout main
   git pull --ff-only
   ```

2. Draft the changelog. The helper prints the commits since the last tag and a prompt for drafting
   user-facing entries:

   ```bash
   npm run release:prep
   ```

   Paste the output into an LLM, review the result, and add it under `## [Unreleased]` in
   `CHANGELOG.md`, grouped as [Keep a Changelog] sections (Added, Changed, Fixed, Removed, Security).
   Commit it to `main` and push. The release refuses to start without at least one entry.

3. Run the full verification suite:

   ```bash
   npm run verify
   ```

   It type-checks, builds, runs the tests, and smoke-tests the exact `npm pack` tarball: installs it
   with production dependencies only, checks the `overshare X.Y.Z (sha7 YYYY-MM-DD)` line for both
   command names, that the viewer build and integrations ship (and source maps don't), then generates
   fake sessions and runs `report` and an HTML `export` with the installed copy.

4. **If the share format or the viewer changed, deploy the viewer first** (see
   [Deploying the viewer](#deploying-the-viewer)). Shares are always opened by the latest hosted
   viewer, so it has to understand a new format before a CLI that writes it is published.

## Release

Preview first. The dry run turns off npm and GitHub, so it cannot publish anything, but it still
requires a clean `main`:

```bash
npm run release:dry
```

Then release interactively:

```bash
npm run release           # or: npm run release -- patch|minor|major
```

In order, `npm run release`:

1. refuses to start when not logged in to npm or when `HEAD` is already the release;
2. checks that Unreleased has entries and runs `npm run verify`;
3. bumps the version in `package.json` and `package-lock.json` and moves the Unreleased entries under
   the new version;
4. packs and smoke-tests the package again at the new version;
5. commits `chore: release vX.Y.Z`, tags `vX.Y.Z` and pushes both;
6. creates a GitHub Release from the changelog notes; and
7. publishes to npm **from the tagged commit** (`scripts/release.mjs`; npm's own step is turned off in
   `.release-it.json`, so the published build is stamped with the release commit and a clean tree).
   npm may ask for a one-time password here.

Pick the bump by what users see: **patch** for fixes, **minor** for new features (and, before 1.0,
for breaking changes), **major** after 1.0 for removed or changed commands and options.

A prerelease is published under a dist-tag named after its identifier, so `latest` keeps pointing at
the last full release:

```bash
npm run release -- --preRelease=beta                    # 1.3.0-beta.0, published as overshare@beta
npm run release -- --preRelease=beta --npm.tag=next     # same version, under "next"
```

Other variants:

```bash
npm run release -- 0.5.0                               # a specific version, without the prompt
npm run release -- 0.5.0 --npm.allowSameVersion        # re-release the version already in package.json
npm run release -- --no-github                         # skip the GitHub Release (create it later, below)
```

## If a release fails partway

First check whether npm has the version: `npm view overshare@X.Y.Z version` prints it if it was
published. Then find the step that failed. Publishing is last, so a failure before it leaves npm
without the version.

| Failed at | State afterwards | What to do |
| --- | --- | --- |
| Changelog check or `verify` (step 2) | Nothing changed. | Fix the problem and rerun. |
| Bump or package smoke test (steps 3–4) | `package.json`, `package-lock.json` and `CHANGELOG.md` are modified, not committed. | `git checkout -- package.json package-lock.json CHANGELOG.md`, fix, rerun. |
| Commit, tag or push (step 5) | release-it undid its local changes (and deleted its tag); npm does not have the version. | Fix the cause (for a rejected push, allow the push to `main`) and rerun. |
| GitHub Release (step 6) | The commit and tag are pushed; npm does not have the version. | Create the release from the tag (below), then run `npm run release:publish`. |
| npm publish (step 7), e.g. an expired one-time password | Commit, tag, push and GitHub Release are done; only the publish is left. | Fix the cause, then `npm run release:publish` (it publishes the tagged `HEAD`; `-- --tag <tag>` chooses a dist-tag). |

### Never re-run a plain release

Once npm has the version, finish that version with `npm run release:publish`. A plain
`npm run release` would bump to a new version instead, leaving the published one with no commit, tag
or GitHub Release.

### Creating a missing GitHub Release

From the version's changelog section:

```bash
v=X.Y.Z
awk -v v="$v" '$0 ~ "^## \\[" v "\\]" {f=1; next} /^## \[/ {f=0} f' CHANGELOG.md > /tmp/notes.md
gh release create "v$v" --title "v$v" --notes-file /tmp/notes.md
```

## Verify the release

```bash
npm view overshare version
npx -y overshare@latest --version    # overshare X.Y.Z (sha7 YYYY-MM-DD)
npx -y overshare@latest demo         # the viewer opens with fake sessions; nothing is uploaded
```

Published npm versions are immutable. If a release is broken, publish a fixed version (and
`npm deprecate overshare@X.Y.Z "<reason>"` if it is harmful) rather than trying to replace it.

## Deploying the viewer

```bash
npm run preview:cf   # optional: the production build served locally by wrangler, with the real headers
npm run deploy       # builds the viewer and landing page and deploys them
```

Then open <https://overshare.link/> and the example session at
<https://overshare.link/s/#url:examples/session.json> to check. The deploy is independent of npm
versions; redeploying `main` at any time is safe, because the viewer reads every older share format.
See [docs/self-hosting.md](docs/self-hosting.md) for how the deployment is put together.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
