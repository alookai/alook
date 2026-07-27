import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createProxyServerApi } from "./proxyServerApi";

// Helpers for the mocked fetch — build a Response-shaped object that only
// implements what parseJsonResponse touches. Using the real Response class
// makes it hard to simulate an empty body distinct from JSON `"null"`, so a
// hand-rolled stub matches the code path more faithfully.
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
function jsonBody(body: string, init: { status?: number; ok?: boolean; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    headers: new Headers(init.headers ?? {}),
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}
function textThrowingResponse(status: number, cause: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => {
      throw new TypeError(cause);
    },
  } as unknown as Response;
}
function bufferResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    arrayBuffer: async () => bytes.buffer,
    text: async () => "",
  } as unknown as Response;
}

const cfg = { proxyUrl: "http://proxy.test", voucher: "vch_test" };

describe("createProxyServerApi — parseJsonResponse via call<T>", () => {
  it("throws structured 'non-JSON body' on empty 500", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody("", { status: 500 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(api.listServers({ agentId: "a1" as never })).rejects.toThrow(
      /upstream returned 500 with non-JSON body from \/api\/listServers/,
    );
  });

  it("returns undefined on empty 200 (void endpoint like ack)", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody("", { status: 200 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const out = await api.ack({ agentId: "a1", messageIds: [] } as never);
    expect(out).toBeUndefined();
  });

  it("returns undefined on 204 (empty successful body)", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody("", { status: 204 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const out = await api.ack({ agentId: "a1", messageIds: [] } as never);
    expect(out).toBeUndefined();
  });

  it("throws 'non-JSON body' on truncated HTML 502", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody("<html>bad gateway", { status: 502 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(api.listServers({ agentId: "a1" as never })).rejects.toThrow(
      /upstream returned 502 with non-JSON body from \/api\/listServers/,
    );
  });

  it("throws 'body read failed' when res.text() rejects mid-read", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => textThrowingResponse(500, "terminated"));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(api.listServers({ agentId: "a1" as never })).rejects.toThrow(
      /upstream body read failed from \/api\/listServers \(500\): terminated/,
    );
  });

  it("preserves .code and .hint from a structured error body on non-2xx", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonBody(JSON.stringify({ error: "not allowed", code: "forbidden", hint: "check owner" }), { status: 403 }),
    );
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    try {
      await api.listServers({ agentId: "a1" as never });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe("not allowed");
      expect((err as { code?: string }).code).toBe("forbidden");
      expect((err as { hint?: string }).hint).toBe("check owner");
    }
  });

  it("returns parsed JSON on 2xx", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonBody(JSON.stringify({ servers: [{ id: "srv_1" }] }), { status: 200 }),
    );
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const out = await api.listServers({ agentId: "a1" as never });
    expect(out).toEqual({ servers: [{ id: "srv_1" }] });
  });
});

describe("createProxyServerApi — reactAdd", () => {
  it("POSTs to /api/reactAdd with Bearer voucher and JSON body (no agentId)", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ ok: true, duplicate: false }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const res = await api.reactAdd({ channel: "/demo/general", seq: 42, emoji: "👍" });
    expect(res).toEqual({ ok: true, duplicate: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://proxy.test/api/reactAdd");
    expect(seen[0].init?.method).toBe("POST");
    const headers = seen[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer vch_test");
    const body = JSON.parse(String(seen[0].init?.body ?? "{}"));
    expect(body).toEqual({ channel: "/demo/general", seq: 42, emoji: "👍" });
    expect(body.agentId).toBeUndefined();
  });
});

describe("createProxyServerApi — send forwards replyToSeq", () => {
  it("POSTs replyToSeq in the body (agentId stripped, replyToSeq retained)", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(
        JSON.stringify({ state: "sent", message: { seq: "#8", channel: "/demo/general", sender: "@a", content: { text: "on it" }, time: "" } }),
        { status: 200 },
      );
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await api.send({ agentId: "a1", channel: "/demo/general", content: { text: "on it" }, replyToSeq: 37 });
    expect(seen[0].url).toBe("http://proxy.test/api/send");
    const body = JSON.parse(String(seen[0].init?.body ?? "{}"));
    expect(body.replyToSeq).toBe(37);
    expect(body.agentId).toBeUndefined();
  });
});

describe("createProxyServerApi — callUpload via parseJsonResponse", () => {
  it("throws 'non-JSON body' on empty 500", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody("", { status: 500 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(
      api.attachmentUpload({
        agentId: "a1",
        target: "/c/s/g",
        file: { data: new Uint8Array([1, 2, 3]), filename: "x.png", contentType: "image/png" },
      } as never),
    ).rejects.toThrow(/upstream returned 500 with non-JSON body from \/api\/attachmentUpload/);
  });
});

describe("createProxyServerApi — callDownload", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pxdl-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("routes empty-500 error branch through parseJsonResponse", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody("", { status: 500 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(
      api.attachmentDownload({ agentId: "a1", id: "att_1", destPath: path.join(tmp, "out.bin") } as never),
    ).rejects.toThrow(/upstream returned 500 with non-JSON body from \/api\/attachmentDownload/);
  });

  it("happy path writes the binary body to destPath", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl: FetchLike = vi.fn(async () =>
      bufferResponse(bytes, {
        "content-type": "image/png",
        "content-length": String(bytes.length),
        "x-alook-filename": encodeURIComponent("hi.png"),
      }),
    );
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const dest = path.join(tmp, "out.png");
    const out = await api.attachmentDownload({ agentId: "a1", id: "att_1", destPath: dest } as never);
    expect(out.path).toBe(dest);
    expect(out.filename).toBe("hi.png");
    expect(out.contentType).toBe("image/png");
    expect(out.size).toBe(bytes.length);
    expect(fs.readFileSync(dest)).toEqual(Buffer.from(bytes));
  });
});

describe("createProxyServerApi — friendRequest / listFriends", () => {
  it("friendRequest POSTs to /api/friendRequest, strips agentId, decodes the envelope", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(
        JSON.stringify({ friendshipId: "fr_1", status: "pending", hint: "ask your owner" }),
        { status: 200 },
      );
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const res = await api.friendRequest({ agentId: "a1" as never, username: "Alice#0042" });
    expect(res).toEqual({ friendshipId: "fr_1", status: "pending", hint: "ask your owner" });
    expect(seen[0].url).toBe("http://proxy.test/api/friendRequest");
    expect(seen[0].init?.method).toBe("POST");
    const body = JSON.parse(String(seen[0].init?.body ?? "{}"));
    expect(body).toEqual({ username: "Alice#0042" });
    expect(body.agentId).toBeUndefined();
  });

  it("friendRequest surfaces .code and .hint from a 409 error body", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonBody(JSON.stringify({ error: "already friends", code: "already_friends", hint: "already" }), { status: 409 }),
    );
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    try {
      await api.friendRequest({ agentId: "a1" as never, username: "Bob#0042" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe("already friends");
      expect((err as { code?: string }).code).toBe("already_friends");
      expect((err as { hint?: string }).hint).toBe("already");
    }
  });

  it("listFriends POSTs to /api/listFriends and decodes the three buckets verbatim", async () => {
    const seen: Array<{ url: string }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      seen.push({ url });
      return jsonBody(
        JSON.stringify({ accepted: [{ userId: "u1", handle: "A#1" }], pendingOutgoing: [], pendingIncoming: [] }),
        { status: 200 },
      );
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const res = await api.listFriends({ agentId: "a1" as never });
    expect(res).toEqual({ accepted: [{ userId: "u1", handle: "A#1" }], pendingOutgoing: [], pendingIncoming: [] });
    expect(seen[0].url).toBe("http://proxy.test/api/listFriends");
  });

  it("both throw the 'non-JSON body' pattern on an empty 500", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody("", { status: 500 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(api.friendRequest({ agentId: "a1" as never, username: "A#0001" })).rejects.toThrow(
      /upstream returned 500 with non-JSON body from \/api\/friendRequest/,
    );
    await expect(api.listFriends({ agentId: "a1" as never })).rejects.toThrow(
      /upstream returned 500 with non-JSON body from \/api\/listFriends/,
    );
  });
});
