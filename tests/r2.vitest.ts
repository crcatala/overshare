import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createPublisher, parseShareRef } from "../src/publish/index.js";
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
      const result = await publisher.publish({ filename: "session.json", content: '{"schema":"agentshare/1"}', description: "d" });
      expect(result.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(result.viewerUrl).toBe(`https://viewer.example.com/session/#r2:${result.id}`);
      expect(result.url).toBe(`https://shares.example.com/s/${result.id}.json`);
      const put = s3.requests[0]!;
      expect(put.method).toBe("PUT");
      expect(put.url).toBe(`/shares/s/${result.id}.json`);
      expect(put.body).toBe('{"schema":"agentshare/1"}');
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
    expect(createPublisher(config, "r2", { AGENT_SHARE_R2_ACCESS_KEY_ID: "a", AGENT_SHARE_R2_SECRET_ACCESS_KEY: "b" }).name).toBe("r2");
    expect(createPublisher(DEFAULT_CONFIG, "gist", {}).name).toBe("gist");
  });
});

describe("parseShareRef", () => {
  it.each([
    ["https://agent.nub.sh/session/#r2:AbCdEfGhIjKlMnOpQrStUv", { target: "r2", id: "AbCdEfGhIjKlMnOpQrStUv" }],
    ["https://agent.nub.sh/session/#crcatala-vps/5260b8cf9b1baae31a40717ac1ab5f08&view=minimal", { target: "gist", id: "5260b8cf9b1baae31a40717ac1ab5f08" }],
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
});
