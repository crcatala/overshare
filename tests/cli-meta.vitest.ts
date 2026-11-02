import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersions, detectInstall, formatVersion, updateSteps, versionLine, type PackageMeta } from "../src/cli-meta.js";

// cli-meta is the only code that knows the CLI's version string and update command; these tests pin its
// public format so `test:package` and the release standard's contract stay in step.

const root = join(import.meta.dirname, "..");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

describe("cli-meta", () => {
  it("formats the --version line as `name X.Y.Z (sha7 YYYY-MM-DD)`", () => {
    expect(formatVersion("overshare", { version: "1.4.2", commit: "a1b2c3d4e5f6", date: "2026-10-27" })).toBe("overshare 1.4.2 (a1b2c3d 2026-10-27)");
    expect(formatVersion("ovs", { version: "1.4.3", commit: "9f8e7d6c5b4a", date: "2026-10-28", dirty: true })).toBe(
      "ovs 1.4.3 (9f8e7d6-dirty 2026-10-28)",
    );
  });

  it("prints no parentheses without a commit, and no date when the date is unknown", () => {
    expect(formatVersion("overshare", { version: "1.4.2" })).toBe("overshare 1.4.2");
    expect(formatVersion("overshare", { version: "1.4.3", commit: "0123456789ab", dirty: true })).toBe("overshare 1.4.3 (0123456-dirty)");
  });

  it("reads this checkout's own commit", () => {
    // Tests run from src/ in the repository, so this reads git rather than a build stamp.
    expect(versionLine("overshare")).toMatch(new RegExp(`^overshare ${version.replace(/\./g, "\\.")} \\([0-9a-f]{7}(-dirty)? \\d{4}-\\d{2}-\\d{2}\\)$`));
  });

  it("compares plain and prerelease versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.3.0-beta.0", "1.3.0")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.3.0-beta.0")).toBeGreaterThan(0);
  });

  it("names the install method from the install path", () => {
    expect(detectInstall("/src/overshare", true)).toBe("checkout");
    expect(detectInstall("/home/u/.npm/_npx/abc/node_modules/overshare", false, "/usr/lib/node_modules")).toBe("npx");
    expect(detectInstall("/home/u/.local/share/mise/installs/npm-overshare/0.4.2/lib/node_modules/overshare", false)).toBe("mise");
    expect(detectInstall("/home/u/.bun/install/global/node_modules/overshare", false)).toBe("bun");
    expect(detectInstall("/home/u/.pnpm-global/node_modules/overshare", false)).toBe("pnpm");
    expect(detectInstall("/usr/lib/node_modules/overshare", false, "/usr/lib/node_modules")).toBe("npm");
    expect(detectInstall("/opt/somewhere/overshare", false, "/usr/lib/node_modules")).toBe("unknown");
  });

  it("updates a source checkout with git, the package manager and the build", () => {
    const meta: PackageMeta = { root: "/src/overshare", name: "overshare", version: "0.4.2", isPrivate: false };
    expect(updateSteps("checkout", meta, "npm")).toEqual([
      { cmd: "git", args: ["pull", "--ff-only", "origin", "main"], cwd: "/src/overshare" },
      { cmd: "npm", args: ["install"], cwd: "/src/overshare" },
      { cmd: "npm", args: ["run", "build"], cwd: "/src/overshare" },
    ]);
    expect(updateSteps("npm", meta)).toEqual([{ cmd: "npm", args: ["install", "-g", "overshare@latest"] }]);
    expect(updateSteps("unknown", meta)).toBeNull();
  });
});
