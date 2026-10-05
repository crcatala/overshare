# Releasing

overshare ships as two things that are released separately:

- **The npm package** (`overshare`): the CLI, plus the viewer build used by `overshare serve` and
  single-file HTML exports. Released with [release-it](https://github.com/release-it/release-it) from a
  maintainer machine.
- **The hosted viewer and landing page** at <https://overshare.link>: deployed to Cloudflare with
  `npm run deploy`. Every share link opens in it, so it must be live before anyone publishes.

## Prerequisites

- Push access to `crcatala/overshare` and a clean checkout of `main`. release-it pushes the release
  commit and tag straight to `main`, so if `main` is protected, allow yourself to bypass the rule.
- An npm account with publish rights to `overshare` (`npm whoami`), with two-factor auth set up
- A GitHub token in `GITHUB_TOKEN` with **Contents: read and write** on the repository, so
  release-it can create the GitHub Release
- Node.js `^22.22.2 || ^24.15.0 || >=26` (release-it's requirement; users only need 22.19)
- For viewer deploys: `npx wrangler login` with access to the Cloudflare account that serves
  overshare.link

## Before releasing

1. Update `main`:

   ```bash
   git checkout main
   git pull --ff-only
   ```

2. Write the changelog. The helper prints the commits since the last tag and a prompt for drafting
   user-facing entries:

   ```bash
   npm run release:prep
   ```

   Add entries under `## [Unreleased]` in `CHANGELOG.md`, grouped as [Keep a Changelog] sections
   (Added, Changed, Fixed, Removed, Security). The release refuses to start without at least one.
   Get the changelog onto `main` (commit or PR) before releasing.

3. Run the full verification suite:

   ```bash
   npm run verify
   ```

   It type-checks, builds, runs the tests, and smoke-tests the exact `npm pack` tarball: installs it
   with production dependencies only, checks `overshare`/`ovs --version`, that the viewer build and
   integrations ship (and source maps don't), then generates fake sessions and runs `report` and an
   HTML `export` with the installed copy.

4. **If the share format or the viewer changed, deploy the viewer first** (see
   [Deploying the viewer](#deploying-the-viewer)). Shares are always opened by the latest hosted
   viewer, so it has to understand a new format before a CLI that writes it is published.

## Release

### First release

There is no prior tag, and `package.json` already holds the version to publish (`0.1.0`), so release
it as is instead of bumping:

Preview it first (npm and GitHub are turned off, so nothing is published):

```bash
npm run release:first -- --dry-run --no-npm --no-github
```

Then:

```bash
export GITHUB_TOKEN=github_pat_...   # if not already set
npm run release:first
```

The `[Unreleased]` entries in `CHANGELOG.md` are already written for 0.1.0. They become
`## [0.1.0] - <date>` and a fresh empty `[Unreleased]` section is added above them.

### Later releases

Preview first. `release:dry` turns off npm and GitHub, so it cannot publish anything, but it still
requires a clean `main`:

```bash
npm run release:dry
```

Then release interactively:

```bash
npm run release
```

release-it asks for the version bump, then:

1. checks for a clean `main`, unreleased changelog entries, and runs `npm run verify`;
2. updates `package.json` and moves the Unreleased entries under the new version;
3. packs and smoke-tests the package again at the new version;
4. commits `chore: release vX.Y.Z` and tags `vX.Y.Z`;
5. publishes `overshare` to npm (`prepublishOnly` runs `npm run verify` once more);
6. pushes the commit and tag; and
7. creates a GitHub Release from the changelog notes.

Pick the bump by what users see: **patch** for fixes, **minor** for new features (and, before 1.0,
for breaking changes), **major** after 1.0 for removed or changed commands and options.

Recovery and variants:

```bash
npm run release -- --no-npm          # npm publish already succeeded in a partial release
npm run release -- --no-github       # skip the GitHub Release
npm run release -- 0.2.0             # a specific version, without the prompt
npm run release -- --preRelease=beta # a prerelease, published under the `beta` dist-tag
```

## Verify the release

```bash
npm view overshare
npx -y overshare@latest --version
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
