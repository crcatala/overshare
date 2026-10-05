import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { accessWarnings, createPublisher, parseShareRef, preflightWarnings } from "../src/publish/index.js";
import { R2Publisher, checkPublicAccess, r2SourceTemplate, type R2Config } from "../src/publish/r2.js";

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

async function mockS3(status = 200) {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(status).end(status === 200 ? "" : "<Error>AccessDenied</Error>");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { requests, endpoint, close: () => server.close() };
}

const credentials = { accessKeyId: "AKIDTEST", secretAccessKey: "test-secret-key" };

describe("R2Publisher", () => {
  it("PUTs the share with a SigV4 signature and returns an #r2:<id> viewer link", async () => {
    const s3 = await mockS3();
    try {
      const config: R2Config = { bucket: "shares", prefix: "s/", publicUrl: "https://shares.example.com/", endpoint: s3.endpoint };
      const publisher = new R2Publisher({ config, credentials, viewerUrl: "https://viewer.example.com/session/" });
      const result = await publisher.publish({ filename: "session.json", content: '{"schema":"overshare/1"}', description: "d" });
      expect(result.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(result.viewerUrl).toBe(`https://viewer.example.com/session/#r2:${result.id}`);
      expect(result.url).toBe(`https://shares.example.com/s/${result.id}.json`);
      const put = s3.requests[0]!;
      expect(put.method).toBe("PUT");
      expect(put.url).toBe(`/shares/s/${result.id}.json`);
      expect(put.body).toBe('{"schema":"overshare/1"}');
      expect(put.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request/);

      await publisher.delete(result.id);
      expect(s3.requests[1]).toMatchObject({ method: "DELETE", url: `/shares/s/${result.id}.json` });
    } finally {
      s3.close();
    }
  });

  it("surfaces upload errors", async () => {
    const s3 = await mockS3(403);
    try {
      const publisher = new R2Publisher({ config: { bucket: "b", publicUrl: "https://x", endpoint: s3.endpoint }, credentials, viewerUrl: "v" });
      await expect(publisher.publish({ filename: "session.json", content: "{}", description: "d" })).rejects.toThrow(/R2 upload failed \(403\)/);
    } finally {
      s3.close();
    }
  });

  it("builds the viewer source template from the same settings", () => {
    expect(r2SourceTemplate({ bucket: "b", prefix: "s/", publicUrl: "https://shares.example.com" })).toBe("https://shares.example.com/s/{id}.json");
  });

  it("checks public access and CORS like the viewer would", async () => {
    const ok = async () => new Response("{}", { status: 200, headers: { "access-control-allow-origin": "https://viewer.example.com" } });
    const noCors = async () => new Response("{}", { status: 200 });
    expect(await checkPublicAccess("https://x/s/a.json", "https://viewer.example.com", ok as typeof fetch)).toEqual({ status: 200, cors: true });
    expect(await checkPublicAccess("https://x/s/a.json", "https://viewer.example.com", noCors as typeof fetch)).toEqual({ status: 200, cors: false });
  });
});

describe("createPublisher", () => {
  it("requires r2 config and credentials", () => {
    expect(() => createPublisher(DEFAULT_CONFIG, "r2", {})).toThrow(/"r2" section/);
    const config = { ...DEFAULT_CONFIG, r2: { bucket: "b", publicUrl: "https://x", accountId: "acc" } };
    expect(() => createPublisher(config, "r2", {})).toThrow(/credentials missing/);
    expect(createPublisher(config, "r2", { OVERSHARE_R2_ACCESS_KEY_ID: "a", OVERSHARE_R2_SECRET_ACCESS_KEY: "b" }).name).toBe("r2");
    expect(createPublisher(DEFAULT_CONFIG, "gist", {}).name).toBe("gist");
  });
});

describe("parseShareRef", () => {
  it.each([
    ["https://overshare.link/session/#r2:AbCdEfGhIjKlMnOpQrStUv", { target: "r2", id: "AbCdEfGhIjKlMnOpQrStUv" }],
    ["https://overshare.link/session/#crcatala-vps/5260b8cf9b1baae31a40717ac1ab5f08&view=minimal", { target: "gist", id: "5260b8cf9b1baae31a40717ac1ab5f08" }],
    ["https://gist.github.com/crcatala-vps/5260b8cf9b1baae31a40717ac1ab5f08", { target: "gist", id: "5260b8cf9b1baae31a40717ac1ab5f08" }],
    ["5260b8cf9b1baae31a40717ac1ab5f08", { target: "gist", id: "5260b8cf9b1baae31a40717ac1ab5f08" }],
    ["r2:AbCdEfGhIjKlMnOpQrStUv", { target: "r2", id: "AbCdEfGhIjKlMnOpQrStUv" }],
  ])("parses %s", (input, expected) => {
    expect(parseShareRef(input)).toEqual(expected);
  });

  it("uses the fallback target for bare non-gist ids and rejects junk", () => {
    expect(parseShareRef("AbCdEfGhIjKlMnOpQrStUv", "r2")).toEqual({ target: "r2", id: "AbCdEfGhIjKlMnOpQrStUv" });
    expect(() => parseShareRef("not a link!")).toThrow();
  });

  it("accepts the R2 data URL that publish prints", () => {
    const r2 = { bucket: "b", prefix: "s/", publicUrl: "https://shares.example.com/" };
    expect(parseShareRef("https://shares.example.com/s/AbCdEfGhIjKlMnOpQrStUv.json", "gist", r2)).toEqual({ target: "r2", id: "AbCdEfGhIjKlMnOpQrStUv" });
    expect(() => parseShareRef("https://other.example.com/s/AbCdEfGhIjKlMnOpQrStUv.json", "gist", r2)).toThrow();
  });

  it("parses raw gist URLs", () => {
    expect(parseShareRef("https://gist.githubusercontent.com/octo/5260b8cf9b1baae31a40717ac1ab5f08/raw/session.json")).toEqual({
      target: "gist",
      id: "5260b8cf9b1baae31a40717ac1ab5f08",
    });
  });

  it.each([
    ["a commit URL ending in hex", "https://github.com/acme/repo/commit/8309559a1b2c3d4e5f60718293a4b5c6d7e8f901"],
    ["a bare 40-hex commit sha", "8309559a1b2c3d4e5f60718293a4b5c6d7e8f901"],
    ["a local viewer link", "http://localhost:3000/session/#local:x.json"],
    ["a bare non-gist id without an r2 fallback", "AbCdEfGhIjKlMnOpQrStUv"],
  ])("refuses %s (delete is destructive)", (_name, input) => {
    expect(() => parseShareRef(input, "gist")).toThrow();
  });
});

describe("publish warnings", () => {
  const r2Config = { ...DEFAULT_CONFIG, target: "r2" as const, r2: { bucket: "b", publicUrl: "https://shares.example.com" } };

  it("warns before uploading to R2 while viewerUrl is still the built-in default", () => {
    expect(preflightWarnings({ ...r2Config, viewerUrlSource: "default" }, "r2")[0]).toMatch(/viewerUrl is the built-in default/);
    expect(preflightWarnings({ ...r2Config, viewerUrlSource: "config" }, "r2")).toEqual([]);
    expect(preflightWarnings({ ...DEFAULT_CONFIG, viewerUrlSource: "default" }, "gist")).toEqual([]);
  });

  it("reports missing public access or CORS after an R2 upload", async () => {
    const result = { publisher: "r2", id: "x", url: "u", viewerUrl: "v", rawUrl: "https://shares.example.com/x.json" };
    const respond = (status: number, headers: Record<string, string> = {}) => (async () => new Response("{}", { status, headers })) as typeof fetch;
    expect(await accessWarnings(r2Config, "r2", result, respond(404))).toEqual([expect.stringMatching(/returned 404/)]);
    expect(await accessWarnings(r2Config, "r2", result, respond(200))).toEqual([expect.stringMatching(/CORS policy does not allow https:\/\/overshare\.link/)]);
    expect(await accessWarnings(r2Config, "r2", result, respond(200, { "access-control-allow-origin": "*" }))).toEqual([]);
    expect(await accessWarnings(r2Config, "gist", result, respond(404))).toEqual([]);
  });
});
