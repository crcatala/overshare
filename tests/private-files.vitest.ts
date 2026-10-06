import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Lets a test predict the temp file's name, to plant a file there first.
const fixedSuffix = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, randomBytes: (n: number) => (fixedSuffix.value ? Buffer.from(fixedSuffix.value, "hex") : real.randomBytes(n)) };
});

const { writePrivateFile } = await import("../src/sessions/private-files.js");

const mode = (path: string) => statSync(path).mode & 0o777;
const scratch = () => mkdtempSync(join(tmpdir(), "as-private-"));

describe("writePrivateFile", () => {
  afterEach(() => {
    fixedSuffix.value = undefined;
  });

  it("creates missing directories 0700 and the file 0600", () => {
    const root = scratch();
    const path = join(root, "a", "b", "shares.json");
    writePrivateFile(path, "{}\n");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    expect(mode(path)).toBe(0o600);
    expect(mode(join(root, "a"))).toBe(0o700);
    expect(mode(join(root, "a", "b"))).toBe(0o700);
  });

  it("makes an existing 0644 file private when it replaces it", () => {
    const path = join(scratch(), "browse.json");
    writeFileSync(path, "old", { mode: 0o644 });
    expect(mode(path)).toBe(0o644);
    writePrivateFile(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(mode(path)).toBe(0o600);
  });

  it("leaves an existing directory's mode alone", () => {
    const dir = join(scratch(), "shared");
    mkdirSync(dir, { mode: 0o755 });
    writePrivateFile(join(dir, "index.json"), "{}");
    expect(mode(dir)).toBe(0o755);
    expect(mode(join(dir, "index.json"))).toBe(0o600);
  });

  it("refuses to reuse a file already at the temp name, so it cannot lend the result its mode", () => {
    const dir = scratch();
    const path = join(dir, "shares.json");
    writeFileSync(path, "kept", { mode: 0o600 });
    fixedSuffix.value = "0123456789ab";
    const planted = `${path}.0123456789ab.tmp`;
    writeFileSync(planted, "planted", { mode: 0o644 });
    expect(() => writePrivateFile(path, "secret")).toThrow(/EEXIST/);
    expect(readFileSync(path, "utf8")).toBe("kept");
    expect(mode(path)).toBe(0o600);
    expect(readFileSync(planted, "utf8")).toBe("planted"); // not ours, so not removed
  });

  it("leaves no temp file behind when the rename fails", () => {
    const dir = scratch();
    const path = join(dir, "shares.json");
    mkdirSync(path); // a directory where the file should go makes the rename fail
    expect(() => writePrivateFile(path, "secret")).toThrow();
    expect(readdirSync(dir)).toEqual(["shares.json"]);
  });
});
