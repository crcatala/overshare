import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromModelsDev, renderTable } from "../scripts/prices.ts";

// Runs scripts/price-bot.sh (the update-prices workflow's logic) for real against a local bare repository as
// `origin` and a stub `gh` (tests/fixtures/price-bot/gh) that keeps PRs and issues in a JSON file. The generator
// and the test suite are replaced by stand-ins (PRICE_BOT_UPDATE, PRICE_BOT_TESTS).
const BOT = join(import.meta.dirname, "..", "scripts", "price-bot.sh");
const STUB_DIR = join(import.meta.dirname, "fixtures", "price-bot");
const BRANCH = "bot/update-prices";

const fresh = fromModelsDev(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "prices", "models-dev.json"), "utf8")));
const FRESH_TABLE = renderTable(fresh);
const STALE_TABLE = FRESH_TABLE.replace('"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1,', '"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2,');
const SUMMARY = { snapshot: fresh.snapshot, source: "fixture", upToDate: false, added: [], removed: [], changed: [{ id: "claude-sonnet-5-5", fields: { cacheRead: [0.2, 0.1] } }], prices: fresh.prices, crossCheck: { disagreements: [], onlyOurs: [], onlyLitellm: [] } };

interface Pr {
  number: number;
  state: string;
  headRefName: string;
  baseRefName: string;
  title?: string;
  body?: string;
}
interface Issue {
  number: number;
  state: string;
  title: string;
  labels: string[];
  comments: string[];
}
interface State {
  origin: string;
  next: number;
  prs: Pr[];
  issues: Issue[];
  labels: string[];
  previousRun?: string;
  badToken?: string;
  calls: { args: string[]; token?: string }[];
}

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repository whose `main` holds `table`, pushed to a bare origin, and the stub's state. */
function setup(table = STALE_TABLE) {
  const dir = mkdtempSync(join(tmpdir(), "price-bot-"));
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(join(work, "src"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.name", "test");
  git(work, "config", "user.email", "test@example.invalid");
  git(work, "remote", "add", "origin", origin);
  writeFileSync(join(work, "src", "pricing-data.ts"), table);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "origin", "main");
  const stateFile = join(dir, "state.json");
  const state: State = { origin, next: 1, prs: [], issues: [], labels: [], calls: [] };
  writeFileSync(stateFile, JSON.stringify(state));
  // The generator stand-in: writes the given table and the --json summary, or fails like the real one.
  const update = join(dir, "update.sh");
  writeFileSync(update, `#!/bin/sh\nif [ -n "$UPDATE_FAIL" ]; then echo "update-prices failed: $UPDATE_FAIL" >&2; exit "\${UPDATE_EXIT:-2}"; fi\ncp "$NEW_TABLE" src/pricing-data.ts\ncp "$SUMMARY_FILE" "$1"\n`);
  chmodSync(update, 0o755);
  writeFileSync(join(dir, "summary.json"), JSON.stringify(SUMMARY));
  writeFileSync(join(dir, "fresh.ts"), FRESH_TABLE);
  const read = (): State => JSON.parse(readFileSync(stateFile, "utf8"));
  const write = (s: State) => writeFileSync(stateFile, JSON.stringify(s));

  /** One workflow run: a fresh checkout of `base`, then the bot. */
  const bot = (cmd: "run" | "report", env: Record<string, string> = {}) => {
    const base = env.BASE ?? "main";
    git(work, "checkout", "-q", "-f", base);
    git(work, "reset", "-q", "--hard", `origin/${base}`);
    const output = join(dir, `output-${Date.now()}-${Math.random()}`);
    writeFileSync(output, "");
    const r = spawnSync("bash", [BOT, cmd], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${STUB_DIR}:${process.env.PATH}`,
        GH_STUB_STATE: stateFile,
        GH_REPO: "o/r",
        BASE: base,
        BOT_TOKEN: "bot-token",
        GH_TOKEN: "workflow-token",
        RUN_URL: "https://example.invalid/runs/1",
        RUNNER_TEMP: mkdtempSync(join(dir, "run-")),
        GITHUB_OUTPUT: output,
        PRICE_BOT_UPDATE: update,
        PRICE_BOT_TESTS: "true",
        NEW_TABLE: join(dir, "fresh.ts"),
        SUMMARY_FILE: join(dir, "summary.json"),
        ...env,
      },
    });
    const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs };
  };
  const remoteBranch = () => spawnSync("git", ["--git-dir", origin, "rev-parse", "--verify", "-q", `refs/heads/${BRANCH}`], { encoding: "utf8" }).stdout.trim();
  return { dir, work, origin, read, write, bot, remoteBranch };
}

// Each run starts git, the stub and tsx (for the PR body) several times.
describe("price bot", { timeout: 60_000 }, () => {
  it("opens one PR from bot/update-prices against the ref it ran on, then updates it without pushing again", () => {
    const t = setup();
    const first = t.bot("run");
    expect(first.status, first.stderr).toBe(0);
    expect(first.outputs).toMatchObject({ outcome: "opened", tests: "pass" });
    const [pr] = t.read().prs;
    expect(pr).toMatchObject({ number: 1, state: "open", headRefName: BRANCH, baseRefName: "main", title: "chore(prices): update model price table" });
    expect(pr!.body).toContain("| `claude-sonnet-5-5` | cacheRead $0.2 → $0.1 |");
    // The branch holds one commit on top of main with the new table, by the Actions bot.
    const sha = t.remoteBranch();
    expect(git(t.work, "show", `${sha}:src/pricing-data.ts`)).toBe(FRESH_TABLE.trimEnd());
    expect(git(t.work, "log", "--format=%an|%s", "-1", sha)).toBe("github-actions[bot]|chore(prices): update model price table");
    expect(git(t.work, "rev-parse", `${sha}^`)).toBe(git(t.work, "rev-parse", "origin/main"));
    // The PR and the push use the bot token; nothing else does.
    expect(t.read().calls.filter((c) => c.args[0] === "pr").every((c) => c.token === "bot-token")).toBe(true);

    const second = t.bot("run");
    expect(second.status, second.stderr).toBe(0);
    expect(second.outputs.outcome).toBe("updated");
    expect(t.read().prs).toHaveLength(1);
    expect(t.remoteBranch()).toBe(sha); // same content: not pushed again, so CI is not re-run for nothing
  });

  it("still opens the PR when tests fail with the new table, marked failing", () => {
    const t = setup();
    const r = t.bot("run", { PRICE_BOT_TESTS: "false" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs).toMatchObject({ outcome: "opened", tests: "fail" });
    expect(t.read().prs[0]!.body!.startsWith("> [!WARNING]")).toBe(true);
  });

  it("closes the PR and deletes the branch once the base has the same prices", () => {
    const t = setup();
    t.bot("run");
    expect(t.remoteBranch()).not.toBe("");
    // The PR is merged by hand (simulated): main now has the fresh table.
    git(t.work, "checkout", "-q", "main");
    writeFileSync(join(t.work, "src", "pricing-data.ts"), FRESH_TABLE);
    git(t.work, "commit", "-q", "-am", "merge prices");
    git(t.work, "push", "-q", "origin", "main");
    const r = t.bot("run");
    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs.outcome).toBe("up-to-date");
    expect(t.read().prs[0]!.state).toBe("closed");
    expect(t.remoteBranch()).toBe("");
    // And a run with nothing open and nothing to do does nothing.
    const again = t.bot("run");
    expect(again.outputs.outcome).toBe("up-to-date");
    expect(t.read().calls.filter((c) => c.args[0] === "pr" && c.args[1] !== "list").map((c) => c.args[1])).toEqual(["create", "close"]);
  });

  it("refuses to repoint the branch while it backs an open PR against another base", () => {
    const t = setup();
    t.bot("run");
    const sha = t.remoteBranch();
    git(t.work, "checkout", "-q", "-b", "test-branch", "origin/main");
    git(t.work, "push", "-q", "origin", "test-branch");
    const r = t.bot("run", { BASE: "test-branch" });
    expect(r.status).toBe(1);
    expect(r.outputs).toMatchObject({ failure: "conflict" });
    expect(r.stdout).toContain("already backs open PR #1");
    expect(t.remoteBranch()).toBe(sha);
    expect(t.read().prs).toHaveLength(1);
  });

  it("fails with a clear message when the token is rejected, before using it", () => {
    const t = setup();
    const s = t.read();
    t.write({ ...s, badToken: "bot-token" });
    const r = t.bot("run");
    expect(r.status).toBe(1);
    expect(r.outputs.failure).toBe("token");
    expect(r.stdout).toContain("PRICES_BOT_TOKEN expired or invalid: renew it");
    expect(t.read().calls.map((c) => c.args[0])).toEqual(["api"]);
  });

  it("tells a generator failure from an unreachable models.dev", () => {
    const t = setup();
    const gen = t.bot("run", { UPDATE_FAIL: "claude-x tier 0: unknown tier type" });
    expect(gen.status).toBe(1);
    expect(gen.outputs.failure).toBe("generator");
    expect(gen.outputs.detail).toContain("unknown tier type");
    const fetch = t.bot("run", { UPDATE_FAIL: "could not fetch", UPDATE_EXIT: "3" });
    expect(fetch.outputs.failure).toBe("fetch");
    expect(t.read().prs).toHaveLength(0);
  });

  it("reports failures in one prices issue, with the workflow token", () => {
    const t = setup();
    const first = t.bot("report", { FAILURE: "generator", DETAIL: "update:prices exited 2: boom" });
    expect(first.status, first.stderr).toBe(0);
    const second = t.bot("report", { FAILURE: "token", DETAIL: "PRICES_BOT_TOKEN expired or invalid: renew it" });
    expect(second.status, second.stderr).toBe(0);
    const s = t.read();
    expect(s.issues).toHaveLength(1);
    expect(s.issues[0]).toMatchObject({ title: "Price table update is failing", labels: ["prices"] });
    expect(s.issues[0]!.comments).toHaveLength(2);
    expect(s.issues[0]!.comments[0]).toContain("failed on `main` (generator): update:prices exited 2: boom");
    expect(s.labels).toEqual(["prices"]);
    expect(s.calls.every((c) => c.token === "workflow-token")).toBe(true);
  });

  it("reports an unreachable models.dev only on the second run in a row", () => {
    const t = setup();
    t.write({ ...t.read(), previousRun: "success" });
    expect(t.bot("report", { FAILURE: "fetch" }).stdout).toContain("not opening an issue yet");
    expect(t.read().issues).toHaveLength(0);
    t.write({ ...t.read(), previousRun: "failure" });
    t.bot("report", { FAILURE: "fetch" });
    expect(t.read().issues).toHaveLength(1);
  });
});
