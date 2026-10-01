import { describe, expect, it } from "vitest";
import { stripControls } from "../src/sanitize.js";

describe("stripControls", () => {
  it("keeps ordinary text, newlines, tabs and non-ASCII", () => {
    expect(stripControls("héllo\tworld\nline 2 ✓ 日本語")).toBe("héllo\tworld\nline 2 ✓ 日本語");
  });

  it.each([
    ["OSC 52 clipboard write (BEL)", "a\x1b]52;c;ZXZpbA==\x07b", "ab"],
    ["OSC 52 clipboard write (ST)", "a\x1b]52;c;ZXZpbA==\x1b\\b", "ab"],
    ["OSC 0 title", "a\x1b]0;pwned\x07b", "ab"],
    ["OSC 8 hyperlink", "\x1b]8;;https://evil.example\x07click\x1b]8;;\x07", "click"],
    ["CSI clear screen / SGR / cursor", "a\x1b[2J\x1b[31m\x1b[10;5Hb", "ab"],
    ["DCS string", "a\x1bPq#0;2;0;0;0\x1b\\b", "ab"],
    ["APC string", "a\x1b_Gf=24;AAAA\x1b\\b", "ab"],
    ["two-byte escape", "a\x1bcb", "ab"],
    ["one-byte C1 CSI and carriage return", "a\x9bb\rc", "abc"],
    ["bell, backspace, NUL, DEL", "a\x07\x08\x00\x7fb", "ab"],
  ])("removes %s", (_name, input, expected) => {
    expect(stripControls(input)).toBe(expected);
  });

  it("removes an unterminated sequence up to the end instead of leaving it half-open", () => {
    expect(stripControls("ok\x1b]52;c;ZXZpbA")).toBe("ok");
    expect(stripControls("ok\x1b[")).toBe("ok");
    expect(stripControls("ok\x1b")).toBe("ok");
  });

  it("leaves nothing behind that a terminal would act on", () => {
    const hostile = "\x1b]52;c;AAAA\x07\x1b[?1049h\x1b[?25l\x1b]0;x\x07\x1bPsecret\x1b\\\x1b[6n\x1b(0";
    expect(stripControls(hostile)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });
});
