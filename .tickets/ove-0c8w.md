---
id: ove-0c8w
status: closed
deps: [ove-hfgj]
links: []
created: 2026-11-13T15:33:47Z
type: feature
priority: 2
assignee: cc-vps
parent: ove-izka
tags: [pricing, ci, automation]
---
# Scheduled workflow that keeps one price-update PR open

## Problem

Prices go stale unless someone remembers to regenerate them, and the repo isn't checked often. A weekly job is wanted that keeps exactly one PR open, refreshed on each run, instead of piling up PRs.

## Approach

- `.github/workflows/update-prices.yml`: `schedule` twice a week (e.g. Mon and Thu) plus `workflow_dispatch`. Same runner and pinned-SHA action style as `ci.yml`.
- **Steps:** checkout, `npm ci`, `npm run update:prices -- --json`, then typecheck and tests. On a test failure, still open or update the PR (marked failing in the body) so the problem is visible.
- **One PR at a time:** always use branch `bot/update-prices`, force-pushed every run.
  - PR open + diff: update the branch and PR body.
  - No PR + diff: open one.
  - PR open + no diff (the source reverted, or main already has the change): close the PR and delete the branch.
  - `peter-evans/create-pull-request` does all of this (fixed `branch`, `delete-branch: true`); a small `gh` script is the fallback if we'd rather not add the action.
- **PR body:** added / changed / removed models as a table, LiteLLM disagreements, the snapshot date, and a short "how to verify" line. Title stays fixed ("chore(prices): update model price table") so the PR is easy to find.
- **Generator failures** (unknown tier type, schema change, fetch failure on two consecutive runs): open or update a single issue labelled `prices`, rather than failing silently in the Actions tab.
- **Permissions:** `contents: write`, `pull-requests: write`, `issues: write`, no more.

## Decision pending: the token the bot pushes with

PRs opened with the default `GITHUB_TOKEN` do not trigger `pull_request` workflows, so CI wouldn't run on the bot PR. There is no branch protection on `main` today. Options:
1. **GitHub App** (recommended): a small account-owned app installed on selected repos, minting short-lived tokens via `actions/create-github-app-token`. Needs a one-time setup by the owner (app, private key secret, client id variable).
2. **Fine-grained PAT**: simpler setup, but it expires (max 1 year), acts as the owner, and its PRs look like the owner's own.
3. **No secret:** keep `GITHUB_TOKEN`, add `workflow_dispatch` to `ci.yml`, and have the bot run `gh workflow run ci.yml --ref bot/update-prices` (dispatch events are exempt from the GITHUB_TOKEN rule). Checks attach to the commit and show on the PR, but it's indirect and re-running CI from the PR UI is awkward.

**Decided 2026-11-13: fine-grained PAT** (option 2). Quickest route to a bot PR that runs CI; a GitHub App may replace it later.
- Owner creates a fine-grained PAT scoped to this repo only: Contents (read & write), Pull requests (read & write), Issues (read & write). Longest expiry allowed (max 1 year).
- Stored as repo secret `PRICES_BOT_TOKEN` (`gh secret set PRICES_BOT_TOKEN -R crcatala/overshare`), used by checkout and the PR step only.
- Expiry is the main risk: the job stops working silently. When the token is rejected, the workflow fails with a clear message ("PRICES_BOT_TOKEN expired or invalid: renew it") and opens or updates the same `prices` issue as other generator failures. Note the expiry date in `docs/development.md`.
- PRs will appear as authored by the owner, not a bot; the fixed title and branch keep them recognisable.

## Acceptance criteria

(Updated 2026-11-13: ove-hfgj already committed today's table to main, so a dispatch on main now finds nothing to do. The PR targets the ref the workflow ran on, so the end-to-end test runs against a throwaway branch whose table is deliberately stale; it can only run once the workflow file is on main.)

- A dispatch on main with the table current opens no PR (and closes any stale bot PR).
- Dispatched against a throwaway branch with a deliberately stale table: opens exactly one PR from `bot/update-prices` against that branch, with the expected diff in the PR body, and CI runs on it.
- A second dispatch with no source change updates the same PR (no second PR).
- With the branch brought up to date, the next run closes the PR and deletes `bot/update-prices`.
- A forced generator failure opens or updates exactly one `prices` issue.
- The test branch, PRs and issues are cleaned up afterwards; the run URLs are recorded here as proof.
- `docs/development.md` describes the workflow and how to trigger it by hand.


## Notes

**2026-11-13T16:10:47Z**

PAT created 2026-11-13 by the owner and stored as repo secret PRICES_BOT_TOKEN (scoped to this repo; Contents, Pull requests, Issues read & write). Expires 2027-11-13; renew about a week before. Record the expiry in docs/development.md when the workflow lands.

**2026-11-13T16:50:24Z**

Acceptance criteria updated 2026-11-13 before implementation: the original first criterion (a dispatch on today's data opens a PR with the Haiku 5.5 / Fable 5.2 / Sonnet 5.5 diff) no longer holds because ove-hfgj (#102) already committed that table. The PR base is the dispatched ref, so the end-to-end test uses a throwaway branch with a stale table, after the workflow is on main.

**2026-11-13T17:15:48Z**

End-to-end test passed 2026-11-13, after #103 merged (workflow on main), against a throwaway branch test/price-bot-e2e (Sonnet 5.5 cacheRead set back to 0.2, Fable 5.2 removed). No fixes were needed.

1. Dispatch on main (table current): success, "main already has the current prices", no PR. https://github.com/crcatala/overshare/actions/runs/43469422379
2. Dispatch on the stale branch: opened #104 (bot/update-prices -> test/price-bot-e2e) listing claude-fable-5-2 added and claude-sonnet-5-5 cacheRead 0.2 -> 0.1, LiteLLM no disagreements, tests pass. https://github.com/crcatala/overshare/actions/runs/43469571051
   CI ran on #104 (pull_request event, success): https://github.com/crcatala/overshare/actions/runs/43469918255
3. Second dispatch, no source change: "Updated #104", no second PR, bot/update-prices SHA unchanged (22e0d87, not re-pushed). https://github.com/crcatala/overshare/actions/runs/43470045317
4. Forced generator failure (a SUPPLEMENTAL_PRICES entry shadowing claude-opus-5-5, exit 2): first run opened #105 "Price table update is failing" (label prices) https://github.com/crcatala/overshare/actions/runs/43470571376 ; second run commented on #105, no second issue https://github.com/crcatala/overshare/actions/runs/43470703363
5. Branch brought up to date: "Closed #104", "Deleted bot/update-prices". https://github.com/crcatala/overshare/actions/runs/43470849791

Cleanup: test/price-bot-e2e deleted, #104 closed by the bot (comment added), #105 closed with a comment. The prices label stays (the bot uses it).
Not tested live: an expired/revoked PRICES_BOT_TOKEN (would need a broken secret) and the "models.dev unreachable twice" path; both are covered by tests/price-bot.vitest.ts.
