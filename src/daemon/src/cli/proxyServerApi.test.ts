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

describe("createProxyServerApi — updateProfile", () => {
  it("applies avatar before bio and returns one ordered result", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return url.endsWith("/avatar")
        ? jsonBody(JSON.stringify({ url: "/api/community/bots/b1/avatar" }))
        : jsonBody(JSON.stringify({ aboutMe: "infra" }));
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const result = await api.updateProfile({
      bio: "infra",
      avatar: { filename: "me.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) },
    });
    expect(seen.map((entry) => entry.url)).toEqual([
      "http://proxy.test/api/community/users/me/avatar",
      "http://proxy.test/api/community/users/me/profile",
    ]);
    expect(seen[0]?.init?.body).toBeInstanceOf(FormData);
    expect(seen[1]?.init?.body).toBe(JSON.stringify({ aboutMe: "infra" }));
    expect(result).toEqual({
      updated: ["avatar", "bio"],
      avatarUrl: "/api/community/bots/b1/avatar",
      bio: "infra",
    });
  });

  it("reports explicit partial state when avatar succeeds and bio fails", async () => {
    const fetchImpl: FetchLike = vi.fn()
      .mockResolvedValueOnce(jsonBody(JSON.stringify({ url: "/api/community/bots/b1/avatar" })))
      .mockResolvedValue(jsonBody(JSON.stringify({ error: "bad bio" }), { status: 400 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    try {
      await api.updateProfile({
        bio: "infra",
        avatar: { filename: "me.png", contentType: "image/png", data: new Uint8Array([1]) },
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe("bad bio");
      expect((err as { hint?: string }).hint).toBe("avatar was applied; bio was not applied");
    }
  });

  it("retries bio in place without replaying a previously committed avatar", async () => {
    const fetchImpl: FetchLike = vi.fn()
      .mockResolvedValueOnce(jsonBody(JSON.stringify({ url: "/api/community/bots/b1/avatar" })))
      .mockResolvedValueOnce(jsonBody(JSON.stringify({ error: "temporary" }), { status: 503 }))
      .mockResolvedValueOnce(jsonBody(JSON.stringify({ aboutMe: "infra" })));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });

    await expect(api.updateProfile({
      bio: "infra",
      avatar: { filename: "me.png", contentType: "image/png", data: new Uint8Array([1]) },
    })).resolves.toEqual({
      updated: ["avatar", "bio"],
      avatarUrl: "/api/community/bots/b1/avatar",
      bio: "infra",
    });

    const urls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => url);
    expect(urls.filter((url) => String(url).endsWith("/avatar"))).toHaveLength(1);
    expect(urls.filter((url) => String(url).endsWith("/profile"))).toHaveLength(2);
  });

  it("retains the partial-state hint when every bio retry fails after avatar commit", async () => {
    const fetchImpl: FetchLike = vi.fn()
      .mockResolvedValueOnce(jsonBody(JSON.stringify({ url: "/api/community/bots/b1/avatar" })))
      .mockResolvedValue(jsonBody(JSON.stringify({ error: "D1 unavailable" }), { status: 503 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });

    try {
      await api.updateProfile({
        bio: "infra",
        avatar: { filename: "me.png", contentType: "image/png", data: new Uint8Array([1]) },
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe("D1 unavailable");
      expect((err as { hint?: string }).hint).toBe("avatar was applied; bio was not applied");
    }

    const urls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => url);
    expect(urls.filter((url) => String(url).endsWith("/avatar"))).toHaveLength(1);
    expect(urls.filter((url) => String(url).endsWith("/profile"))).toHaveLength(4);
  });

  it("rejects an empty request before fetch", async () => {
    const fetchImpl: FetchLike = vi.fn();
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(api.updateProfile({})).rejects.toThrow("bio or avatar is required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createProxyServerApi — parseJsonResponse via call<T>", () => {
  it("throws structured 'non-JSON body' on empty 500", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody("", { status: 500 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(api.listServers({ agentId: "a1" as never })).rejects.toThrow(
      /upstream returned 500 with non-JSON body during listServers/,
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
      /upstream returned 502 with non-JSON body during listServers/,
    );
  });

  it("throws 'body read failed' when res.text() rejects mid-read", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => textThrowingResponse(500, "terminated"));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(api.listServers({ agentId: "a1" as never })).rejects.toThrow(
      /upstream body read failed during listServers \(500\): terminated/,
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
      expect((err as { status?: number }).status).toBe(403);
      expect((err as { code?: string }).code).toBe("forbidden");
      expect((err as { hint?: string }).hint).toBe("check owner");
    }
  });

  it("GETs /api/community/servers and projects the superset row down to a lean handle", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      // Superset response the unified GET /servers returns for a bot: full rows
      // with icon/ownerId/description that MUST NOT reach the bot's context.
      return jsonBody(
        JSON.stringify({
          servers: [
            { id: "srv_1", name: "Studio", discriminator: "0042", icon: "https://cdn/x.png", ownerId: "u_owner", description: "secret" },
            { id: "srv_2", name: "Lab", discriminator: "12345", icon: null, ownerId: "u_owner" },
          ],
        }),
        { status: 200 },
      );
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const out = await api.listServers({ agentId: "a1" as never });
    // Single projection point: only the handle survives — no id/name fields or metadata.
    expect(out).toEqual({ servers: [{ handle: "Studio#0042" }, { handle: "Lab#12345" }] });
    // Folded verb hits the real REST path (GET), not a flat POST /api/listServers.
    expect(seen.at(-1)!.url).toBe("http://proxy.test/api/community/servers");
    expect(seen.at(-1)!.init?.method).toBe("GET");
  });
});

describe("createProxyServerApi — joinServer projection", () => {
  it("projects the unified join route superset to one valid handle without identity leakage", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody(JSON.stringify({
      member: { id: "mem_1", userId: "bot_1" },
      serverId: "srv_1",
      server: { id: "srv_1", name: "Design Studio", discriminator: "0042" },
    })));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const out = await api.joinServer({ agentId: "a1" as never, invite: "tok_abc" });

    expect(out).toEqual({ server: { handle: "Design Studio#0042" } });
    expect(Object.keys(out.server)).toEqual(["handle"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://proxy.test/api/community/invites/tok_abc/join",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("createProxyServerApi — reactAdd (retargeted to the canonical reaction door)", () => {
  it("PUTs the canonical reaction door with emoji-in-path + {channel,seq} body (no agentId)", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      // Canonical route returns the reaction ROW on a fresh add.
      return jsonBody(JSON.stringify({ messageId: "m1", userId: "bot_1", emoji: "👍" }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const res = await api.reactAdd({ channel: "/demo#1234/general", seq: 42, emoji: "👍" });
    // Lean contract projection at the proxy boundary: a fresh add → { ok: true }.
    expect(res).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    // messageId is the `resolve` placeholder (bot holds ref+seq, not an id);
    // emoji is the URL-encoded path segment.
    expect(seen[0].url).toBe(
      `http://proxy.test/api/community/messages/resolve/reactions/${encodeURIComponent("👍")}`,
    );
    expect(seen[0].init?.method).toBe("PUT");
    const headers = seen[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer vch_test");
    const body = JSON.parse(String(seen[0].init?.body ?? "{}"));
    // Only channel+seq travel in the body; emoji is the path segment.
    expect(body).toEqual({ channel: "/demo#1234/general", seq: 42 });
    expect(body.agentId).toBeUndefined();
  });

  it("maps a duplicate reaction (route → { duplicate: true }) through to the lean contract", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonBody(JSON.stringify({ ok: true, duplicate: true }), { status: 200 }),
    );
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const res = await api.reactAdd({ channel: "/demo#1234/general", seq: 42, emoji: "👍" });
    expect(res).toEqual({ ok: true, duplicate: true });
  });
});

describe("createProxyServerApi — message marks", () => {
  it("uses the canonical mark resource for set/remove and strips internal identity", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ ok: true }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const target = { channel: "/demo#1234/general", seq: 42 };
    await api.markSet(target);
    await api.markRemove(target);

    expect(seen.map((call) => [call.url, call.init?.method])).toEqual([
      ["http://proxy.test/api/community/messages/resolve/marks", "PUT"],
      ["http://proxy.test/api/community/messages/resolve/marks", "DELETE"],
    ]);
    expect(JSON.parse(String(seen[0].init?.body))).toEqual(target);
    expect(JSON.parse(String(seen[1].init?.body))).toEqual(target);
  });

  it("GETs the caller-scoped aggregate list without a body", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ marked: [] }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(api.listMarks({ agentId: "ignored" })).resolves.toEqual({ marked: [] });
    expect(seen[0]).toMatchObject({
      url: "http://proxy.test/api/community/users/me/marks",
      init: { method: "GET" },
    });
    expect(seen[0].init?.body).toBeUndefined();
  });
});

describe("createProxyServerApi — send (retargeted to the canonical messages door)", () => {
  it("POSTs the canonical door with ref-in-body; replyToSeq retained, agentId stripped", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(
        JSON.stringify({ state: "sent", message: { seq: "#8", channel: "/demo#1234/general", sender: "@a", content: { text: "on it" }, time: "" } }),
        { status: 200 },
      );
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await api.send({ agentId: "a1", channel: "/demo#1234/general", content: { text: "on it" }, replyToSeq: 37 });
    // Canonical messages door; the `resolve` placeholder id (bot holds a ref).
    expect(seen[0].url).toBe("http://proxy.test/api/community/channels/resolve/messages");
    expect(seen[0].init?.method).toBe("POST");
    const body = JSON.parse(String(seen[0].init?.body ?? "{}"));
    // The channel REF stays in the body (resolved server-side); replyToSeq kept.
    expect(body.channel).toBe("/demo#1234/general");
    expect(body.replyToSeq).toBe(37);
    expect(body.agentId).toBeUndefined();
  });
});

describe("createProxyServerApi — channelMember (retargeted to the canonical members door)", () => {
  it("GETs channels/{id}/members with ?ref= (encoded); returns the ChannelMemberResult", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ visibility: "private", members: [{ handle: "a#0001", role: "member" }] }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const res = await api.channelMember({ channel: "/demo#1234/general" });
    expect(res).toEqual({ visibility: "private", members: [{ handle: "a#0001", role: "member" }] });
    const u = new URL(seen[0].url);
    expect(u.pathname).toBe("/api/community/channels/resolve/members");
    expect(u.searchParams.get("ref")).toBe("/demo#1234/general");
    expect(seen[0].init?.method).toBe("GET");
  });
});

describe("createProxyServerApi — listMembers (retargeted to servers/{id}/members)", () => {
  it("GETs servers/{id}/members with ?server= (encoded); returns { members }", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ members: [{ handle: "a#0001", role: "owner" }] }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const res = await api.listMembers({ agentId: "a1", server: "Design Studio" });
    expect(res).toEqual({ members: [{ handle: "a#0001", role: "owner" }] });
    const u = new URL(seen[0].url);
    // servers collection door with the `resolve` placeholder id (bot holds a ref).
    expect(u.pathname).toBe("/api/community/servers/resolve/members");
    expect(u.searchParams.get("server")).toBe("Design Studio");
    expect(seen[0].init?.method).toBe("GET");
  });
});

describe("createProxyServerApi — listChannels (retargeted to servers/{id}/channels + servers/channels)", () => {
  it("single server: GETs servers/{id}/channels with ?server=", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ groups: [] }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await api.listChannels({ agentId: "a1", server: "studio" });
    const u = new URL(seen[0].url);
    expect(u.pathname).toBe("/api/community/servers/resolve/channels");
    expect(u.searchParams.get("server")).toBe("studio");
    expect(seen[0].init?.method).toBe("GET");
  });

  it("all servers (server omitted): GETs the servers/channels collection, no query", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ groups: [] }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await api.listChannels({ agentId: "a1" });
    const u = new URL(seen[0].url);
    expect(u.pathname).toBe("/api/community/servers/channels");
    expect(u.searchParams.get("server")).toBe(null);
    expect(seen[0].init?.method).toBe("GET");
  });
});

describe("createProxyServerApi — inbox trinity pull/snapshot/ack (retargeted to users/me/inbox)", () => {
  it("ack POSTs users/me/inbox/ack with cursors, agentId stripped (advance verb)", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ ok: true, applied: [], failed: [] }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const result = await api.ack({ agentId: "a1", cursors: [{ channel: "/s/c", seq: 5 }] } as never);
    expect(result).toEqual({ ok: true, applied: [], failed: [] });
    expect(seen[0].url).toBe("http://proxy.test/api/community/users/me/inbox/ack");
    expect(seen[0].init?.method).toBe("POST");
    const body = JSON.parse(String(seen[0].init?.body ?? "{}"));
    expect(body.cursors).toEqual([{ channel: "/s/c", seq: 5 }]);
    expect(body.agentId).toBeUndefined();
  });


  it("inboxPull POSTs users/me/inbox/pull with {max} in body, agentId stripped", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ messages: [], hasMore: false, markedCount: 0 }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await api.inboxPull({ agentId: "a1" as never, max: 10 });
    expect(seen[0].url).toBe("http://proxy.test/api/community/users/me/inbox/pull");
    expect(seen[0].init?.method).toBe("POST");
    const body = JSON.parse(String(seen[0].init?.body ?? "{}"));
    expect(body.max).toBe(10);
    expect(body.agentId).toBeUndefined();
  });

  it("inboxPull surfaces an upstream empty 500 as the stable non-JSON error", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody("", { status: 500 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });

    await expect(api.inboxPull({ agentId: "a1" as never, max: 1 })).rejects.toThrow(
      "upstream returned 500 with non-JSON body during inboxPull",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("inboxSnapshot GETs users/me/inbox/snapshot (pure peek, no body)", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ rows: [], pendingChannels: 0, pendingMessages: 0 }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await api.inboxSnapshot({ agentId: "a1" as never });
    expect(seen[0].url).toBe("http://proxy.test/api/community/users/me/inbox/snapshot");
    expect(seen[0].init?.method).toBe("GET");
    expect(seen[0].init?.body).toBeUndefined();
  });
});

describe("createProxyServerApi — nap (retargeted to bots/me/nap)", () => {
  it("nap POSTs bots/me/nap with {handoff}, agentId stripped (bot-self lifecycle)", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ napped: true }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const out = await api.nap({ agentId: "a1", handoff: "see you" } as never);
    expect(seen[0].url).toBe("http://proxy.test/api/community/bots/me/nap");
    expect(seen[0].init?.method).toBe("POST");
    const body = JSON.parse(String(seen[0].init?.body ?? "{}"));
    expect(body.handoff).toBe("see you");
    expect(body.agentId).toBeUndefined();
    expect(out).toEqual({ napped: true });
  });
});

describe("createProxyServerApi — resolve (retargeted to the canonical hydrate door)", () => {
  it("GETs messages/{id} with ref+seq on the query; returns the {message} shape", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(
        JSON.stringify({ message: { seq: "#42", channel: "/demo#1234/general", sender: "@a", content: { text: "hi" }, time: "" } }),
        { status: 200 },
      );
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const res = await api.resolve({ agentId: "a1", channel: "/demo#1234/general", seq: 42 });
    expect(res.message.seq).toBe("#42");
    const u = new URL(seen[0].url);
    // resolve is its OWN door (GET messages/{id} hydrate) — NOT the seq→id lookup.
    expect(u.pathname).toBe("/api/community/messages/resolve");
    expect(u.searchParams.get("ref")).toBe("/demo#1234/general");
    expect(u.searchParams.get("seq")).toBe("42");
    expect(seen[0].init?.method).toBe("GET");
  });
});

describe("createProxyServerApi — read (retargeted to the canonical messages door GET)", () => {
  it("GETs the canonical door with ?ref= (encoded) + seq anchors on the query", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ items: [], hasMore: false }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await api.read({ agentId: "a1", channel: "/demo#1234/general", before: 50, limit: 20 });
    const u = new URL(seen[0].url);
    expect(u.pathname).toBe("/api/community/channels/resolve/messages");
    // ref is URL-encoded on the query (carries `/`).
    expect(u.searchParams.get("ref")).toBe("/demo#1234/general");
    expect(u.searchParams.get("before")).toBe("50");
    expect(u.searchParams.get("limit")).toBe("20");
    expect(seen[0].init?.method).toBe("GET");
  });
});

describe("caller-side ref-encode `/#` round-trip (carry — Ingaborg #267)", () => {
  // A thread ref (`/server/channel/#42`) and a DM-message ref carry `/` AND `#`;
  // the `#` MUST be percent-encoded on the query or the server sees it as a URL
  // fragment and drops it (silently reading the wrong channel). Assert every
  // ref-in-query builder (read / resolve / channelMember) round-trips a `/#` ref
  // intact: the raw URL contains `%23` (not a bare `#`), and decoding the `ref`
  // param yields the original string byte-for-byte.
  const THREAD_REF = "/demo#1234/general/#42"

  function capture() {
    const seen: Array<{ url: string }> = []
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      seen.push({ url })
      return jsonBody(JSON.stringify({ items: [], hasMore: false, message: {}, visibility: "public", hint: "x" }), { status: 200 })
    })
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch })
    return { seen, api }
  }

  function assertRoundTrip(rawUrl: string) {
    // `#` is encoded, not a bare fragment delimiter.
    expect(rawUrl).toContain("%23")
    expect(rawUrl).not.toContain("/#42")
    // decoding the ref param recovers the exact ref.
    const u = new URL(rawUrl)
    expect(u.searchParams.get("ref")).toBe(THREAD_REF)
  }

  it("read round-trips a `/#` thread ref", async () => {
    const { seen, api } = capture()
    await api.read({ agentId: "a1", channel: THREAD_REF })
    assertRoundTrip(seen[0].url)
  })

  it("resolve round-trips a `/#` thread ref", async () => {
    const { seen, api } = capture()
    await api.resolve({ agentId: "a1", channel: THREAD_REF, seq: 42 })
    assertRoundTrip(seen[0].url)
  })

  it("channelMember round-trips a `/#` thread ref", async () => {
    const { seen, api } = capture()
    await api.channelMember({ channel: THREAD_REF })
    assertRoundTrip(seen[0].url)
  })

  it("send carries the `/#` ref in the JSON body (POST — no query encoding needed)", async () => {
    const seen: Array<{ init?: RequestInit }> = []
    const fetchImpl: FetchLike = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push({ init })
      return jsonBody(JSON.stringify({ state: "sent", message: {} }), { status: 200 })
    })
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch })
    await api.send({ agentId: "a1", channel: THREAD_REF, content: { text: "hi" } })
    const body = JSON.parse(String(seen[0].init?.body ?? "{}"))
    // In a JSON body the ref is a plain string value — no URL encoding, intact.
    expect(body.channel).toBe(THREAD_REF)
  })
})

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
    ).rejects.toThrow(/upstream returned 500 with non-JSON body during attachmentUpload/);
  });

  it("POSTs the canonical attachments door with the ref on ?target= (retargeted, `resolve` placeholder id)", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonBody(JSON.stringify({ id: "att_1", filename: "x.png", contentType: "image/png", size: 3 }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const out = await api.attachmentUpload({
      agentId: "a1",
      target: "/demo#1234/general",
      file: { data: new Uint8Array([1, 2, 3]), filename: "x.png", contentType: "image/png" },
    } as never);
    expect(out).toEqual({ id: "att_1", filename: "x.png", contentType: "image/png", size: 3 });
    const u = new URL(seen[0].url);
    expect(u.pathname).toBe("/api/community/channels/resolve/attachments");
    expect(u.searchParams.get("target")).toBe("/demo#1234/general");
    expect(seen[0].init?.method).toBe("POST");
  });

  it("includes thumbnail and dimensions in the canonical multipart body", async () => {
    let form: FormData | undefined;
    const fetchImpl: FetchLike = vi.fn(async (_url: string, init?: RequestInit) => {
      form = init?.body as FormData;
      return jsonBody(JSON.stringify({
        id: "att_1", filename: "x.png", contentType: "image/png", size: 3, hasThumbnail: true,
      }), { status: 200 });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const out = await api.attachmentUpload({
      agentId: "a1",
      target: "/demo#1234/general",
      file: { data: new Uint8Array([1, 2, 3]), filename: "x.png", contentType: "image/png" },
      thumbnail: { data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), filename: "thumbnail.jpg", contentType: "image/jpeg" },
      width: 640,
      height: 480,
    });
    expect(out.hasThumbnail).toBe(true);
    expect((form!.get("thumbnail") as File).type).toBe("image/jpeg");
    expect(form!.get("width")).toBe("640");
    expect(form!.get("height")).toBe("480");
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
    ).rejects.toThrow(/upstream returned 500 with non-JSON body during attachmentDownload/);
  });

  it("happy path writes the binary body to destPath", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchWithCapture: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return bufferResponse(bytes, {
        "content-type": "image/png",
        "content-length": String(bytes.length),
        "x-alook-filename": encodeURIComponent("hi.png"),
      });
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchWithCapture as typeof fetch });
    const dest = path.join(tmp, "out.png");
    const out = await api.attachmentDownload({ agentId: "a1", id: "att_1", destPath: dest } as never);
    expect(out.path).toBe(dest);
    expect(out.filename).toBe("hi.png");
    expect(out.contentType).toBe("image/png");
    expect(out.size).toBe(bytes.length);
    expect(fs.readFileSync(dest)).toEqual(Buffer.from(bytes));
    // Retargeted: GET the canonical attachments door with the id in the PATH
    // (`resolve` placeholder channel segment), not the old POST-body flat verb.
    const u = new URL(seen[0].url);
    expect(u.pathname).toBe("/api/community/channels/resolve/attachments/att_1");
    expect(seen[0].init?.method).toBe("GET");
  });
});

describe("createProxyServerApi — friendRequest / listFriends", () => {
  it("friendRequest POSTs to /api/community/friends/request (retargeted), strips agentId, decodes the envelope", async () => {
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
    expect(seen[0].url).toBe("http://proxy.test/api/community/friends/request");
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

  it("listFriends fans out to friends/accepted + friends/pending (GET, no target-user) and composes 3 buckets", async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method });
      if (url.endsWith("/friends/accepted")) {
        return jsonBody(JSON.stringify({ accepted: [{ userId: "u1", handle: "A#1" }] }), { status: 200 });
      }
      // /friends/pending
      return jsonBody(
        JSON.stringify({ pendingIncoming: [{ userId: "u2", handle: "B#2" }], pendingOutgoing: [] }),
        { status: 200 },
      );
    });
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    const res = await api.listFriends({ agentId: "a1" as never });
    // Composed the flat 3-bucket shape `alook friend list` renders — CLI unchanged.
    expect(res).toEqual({
      accepted: [{ userId: "u1", handle: "A#1" }],
      pendingIncoming: [{ userId: "u2", handle: "B#2" }],
      pendingOutgoing: [],
    });
    const urls = seen.map((s) => s.url).sort();
    expect(urls).toEqual([
      "http://proxy.test/api/community/friends/accepted",
      "http://proxy.test/api/community/friends/pending",
    ]);
    // Bucket reads are GETs and NEVER hit friends/blocked (owner-only, bot-403).
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(seen.some((s) => s.url.includes("/friends/blocked"))).toBe(false);
  });

  it("friendRequest throws the 'non-JSON body' pattern on an empty 500", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody("", { status: 500 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(api.friendRequest({ agentId: "a1" as never, username: "A#0001" })).rejects.toThrow(
      /upstream returned 500 with non-JSON body during friendRequest/,
    );
  });

  it("listFriends throws the 'non-JSON body' pattern when a bucket endpoint 500s", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonBody("", { status: 500 }));
    const api = createProxyServerApi({ ...cfg, fetchImpl: fetchImpl as typeof fetch });
    await expect(api.listFriends({ agentId: "a1" as never })).rejects.toThrow(
      /upstream returned 500 with non-JSON body during listFriends/,
    );
  });
});
