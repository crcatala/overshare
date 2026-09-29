/** Naming shell commands by program, for "Bash(git) ×3" in the outline, chips and rail. */
import { describe, expect, it } from "vitest";
import { commandName, groupCalls, tallyCommands } from "../viewer/src/commands.ts";

describe("commandName", () => {
  it.each([
    ["git status -s", "git"],
    ["ls", "ls"],
    ["  npm test  ", "npm"],
    ["/usr/bin/git log", "git"],
    ["./scripts/build.sh --fast", "build.sh"],
    ["cd app && npm test", "npm"],
    ["cd app; cd src && ls -la", "ls"],
    ["FOO=1 BAR=2 node script.js", "node"],
    ["RTK_DISABLED=1 git diff", "git"],
    ["sudo systemctl restart nginx", "systemctl"],
    ["env NODE_ENV=test vitest run", "vitest"],
    ["rtk git status", "git"],
    ["npx vitest run", "vitest"],
    ["npx -y prettier --check .", "prettier"],
    ["cat a.txt | grep foo", "cat"],
    ["(cd x && make)", "make"],
  ])("%s → %s", (command, name) => {
    expect(commandName(command)).toBe(name);
  });

  it("gives up on empty or assignment-only commands", () => {
    expect(commandName("")).toBeUndefined();
    expect(commandName("   ")).toBeUndefined();
    expect(commandName("FOO=1")).toBeUndefined();
  });

  it("shortens very long names", () => {
    expect(commandName(`./${"x".repeat(60)}`)).toHaveLength(24);
  });
});

describe("tallyCommands", () => {
  it("counts by program, most used first, ties alphabetical", () => {
    expect(tallyCommands(["git status", "ls", "git diff", "npm test", "cd a && ls", "git log"])).toEqual([
      ["git", 3],
      ["ls", 2],
      ["npm", 1],
    ]);
  });
});

describe("groupCalls", () => {
  const group = (calls: { name: string; count: number; errors?: number }[], commands: string[]) => ({
    calls: calls.map((c) => ({ errors: 0, ...c })),
    commands,
  });

  it("splits a shell tool by program and keeps other tools", () => {
    const calls = groupCalls(group([{ name: "Bash", count: 4 }, { name: "Edit", count: 1 }], ["git status", "git diff", "git log", "npm test"]));
    expect(calls.map((c) => [c.label, c.count])).toEqual([
      ["Bash(git)", 3],
      ["Bash(npm)", 1],
      ["Edit", 1],
    ]);
  });

  it("keeps the total when some commands are unknown", () => {
    const calls = groupCalls(group([{ name: "Bash", count: 3 }], ["git status"]));
    expect(calls.map((c) => [c.label, c.count])).toEqual([
      ["Bash(git)", 1],
      ["Bash", 2],
    ]);
  });

  it("reports the shell tool's errors separately, since they can't be assigned to a program", () => {
    const calls = groupCalls(group([{ name: "Bash", count: 2, errors: 1 }], ["git status", "ls"]));
    expect(calls.map((c) => [c.label, c.count, c.errors, c.errorsOnly ?? false])).toEqual([
      ["Bash(git)", 1, 0, false],
      ["Bash(ls)", 1, 0, false],
      ["Bash errors", 1, 1, true],
    ]);
    expect(calls.filter((c) => !c.errorsOnly).reduce((n, c) => n + c.count, 0)).toBe(2);
  });

  it("leaves the tool alone when no commands were kept (minimal)", () => {
    expect(groupCalls(group([{ name: "Bash", count: 5 }], [])).map((c) => [c.label, c.count])).toEqual([["Bash", 5]]);
  });

  it("does not split when several tools run shell commands", () => {
    const calls = groupCalls(group([{ name: "Bash", count: 1 }, { name: "bash", count: 1 }], ["git status", "ls"]));
    expect(calls.map((c) => c.label)).toEqual(["Bash", "bash"]);
  });
});
