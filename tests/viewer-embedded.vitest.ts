// @vitest-environment jsdom
/** The viewer side of the single-file HTML export: reading the session out of the page it is in. */
import { afterEach, describe, expect, it } from "vitest";
import { EMBEDDED_SHARE_ID } from "../src/embedded.ts";
import { jsonForScript } from "../src/standalone.ts";

(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {};
const { embeddedSource, formatHash, loadSource, parseHash } = await import("../viewer/src/source.ts");

const put = (text: string) => {
  document.body.innerHTML = `<script type="application/json" id="${EMBEDDED_SHARE_ID}"></script>`;
  document.getElementById(EMBEDDED_SHARE_ID)!.textContent = text;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("embedded source", () => {
  it("is offered only by a page that carries a session", () => {
    expect(embeddedSource()).toBeUndefined();
    put("{}");
    expect(embeddedSource()).toEqual({ kind: "embedded" });
  });

  it("loads the page's session, escapes undone, without fetching", async () => {
    const session = { schema: "agentshare/2", text: "</script><!-- $&  " };
    put(jsonForScript(JSON.stringify(session)));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("no network");
    }) as typeof fetch;
    try {
      const loaded = await loadSource({ kind: "embedded" });
      expect(loaded.data).toEqual(session);
      expect(loaded.provenance).toEqual({ label: "this HTML file" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("says so when the page has no session", async () => {
    await expect(loadSource({ kind: "embedded" })).rejects.toThrow(/no session/);
  });

  it("can't be asked for by a link, so a hosted viewer is never pointed at a page's element", () => {
    for (const hash of ["#embedded", "#embedded:x", "#embedded:", "#&embedded=1", `#${EMBEDDED_SHARE_ID}`]) {
      expect(parseHash(hash).source?.kind).not.toBe("embedded");
    }
  });

  it("keeps the address bar plain: no source in the hash, params still work", () => {
    expect(formatHash({ source: { kind: "embedded" }, params: new URLSearchParams() })).toBe("#");
    expect(formatHash({ source: { kind: "embedded" }, params: new URLSearchParams({ turn: "3" }) })).toBe("#&turn=3");
    expect(parseHash("#&turn=3")).toMatchObject({ source: undefined });
  });
});
