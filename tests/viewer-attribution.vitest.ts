// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attribution, PROJECT_NAME, REPO_URL } from "../viewer/src/attribution.ts";

describe("attribution", () => {
  it("credits the tool and links to it and its repository, opening in a new tab without leaking the referrer", () => {
    const el = attribution();
    expect(el.textContent).toContain(`Created with ${PROJECT_NAME}`);
    const links = Array.from(el.querySelectorAll("a"));
    expect(links.map((a) => a.textContent)).toEqual([PROJECT_NAME, "GitHub"]);
    for (const a of links) {
      expect(a.href.startsWith("https://")).toBe(true);
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
    }
    expect(links[1]!.href).toBe(REPO_URL);
  });

  it("points at the repository in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as { repository: { url: string } };
    expect(pkg.repository.url).toBe(`git+${REPO_URL}.git`);
  });
});
