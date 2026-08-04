import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { main, setApiForTesting, decodeTextEscapes } from "./index";
import type { ServerApi } from "../server/contract";

/** Capture exactly the JSON object the CLI prints to stdout. */
function captureStdout(): { lines: () => string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines: () => lines, restore: () => spy.mockRestore() };
}

function parseEnvelope(lines: string[]): Record<string, unknown> {
  expect(lines.length).toBe(1); // exactly one JSON object
  return JSON.parse(lines[0]);
}

/** Minimal ServerApi stub; override per test. */
function stubApi(over: Partial<ServerApi> = {}): ServerApi {
  return {
    listServers: async () => ({ servers: [] }),
    listChannels: async () => ({ groups: [] }),
    channelMember: async () => ({ visibility: "public", hint: "" }),
    inboxPull: async () => ({ messages: [], hasMore: false }),
    inboxSnapshot: async () => ({ rows: [], pendingChannels: 0, pendingMessages: 0 }),
    ack: async () => undefined,
    send: async () => ({ state: "sent", message: { seq: "#1", channel: "/s/c", sender: "@a", content: { text: "" }, time: "" } }),
    createPost: async () => ({ ref: "/s/c/post", name: "post", seq: 1 }),
    read: async () => ({ items: [], hasMore: false }),
    resolve: async () => null,
    listMembers: async () => ({ members: [], hasMore: false }),
    joinServer: async () => ({ server: { id: "s", name: "s" } }),
    reactAdd: async () => ({ ok: true, duplicate: false }),
    friendRequest: async () => ({ friendshipId: "fr_1", status: "pending", hint: "Your owner needs to approve this request in DM." }),
    listFriends: async () => ({ accepted: [], pendingOutgoing: [], pendingIncoming: [] }),
    nap: async () => ({ napped: true }),
    ...over,
  } as ServerApi;
}

let cap: ReturnType<typeof captureStdout>;

// Env `getApi`/`proxyServerApiFromEnv` reads to build a proxy-routed ServerApi
// when no API is injected. The daemon INJECTS these into every agent's process
// (credential-proxy handoff), so when an agent runs this suite from inside a
// live daemon they leak into the test and make the "no ServerApi available"
// case silently take the proxy branch instead. The test must isolate its own
// preconditions — unset the whole set here (mirror `proxyServerApiFromEnv`; add
// any new `<PREFIX>_` var it reads to this list) and restore after.
const PROXY_ENV_KEYS = ["ALOOK_PROXY_URL", "ALOOK_PROXY_TOKEN_FILE"] as const;
let savedProxyEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  cap = captureStdout();
  process.env.ALOOK_AGENT_ID = "agent_test";
  savedProxyEnv = {};
  for (const k of PROXY_ENV_KEYS) {
    savedProxyEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  cap.restore();
  setApiForTesting(null);
  delete process.env.ALOOK_AGENT_ID;
  for (const k of PROXY_ENV_KEYS) {
    if (savedProxyEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProxyEnv[k];
  }
});

describe("envelope contract", () => {
  it("prints exactly one JSON object with only `success` on success", async () => {
    setApiForTesting(
      stubApi({
        send: async () => ({
          state: "sent",
          message: { seq: "#7", channel: "/s/general", sender: "@a", content: { text: "hi" }, time: "" },
        }),
      }),
    );
    const code = await main(["message", "send", "--target", "/s/general", "--text", "hi"]);
    const env = parseEnvelope(cap.lines());
    expect(code).toBe(0);
    expect(env).toEqual({ success: { sent: "/s/general#7" } });
    expect("error" in env).toBe(false);
    expect("hint" in env).toBe(false); // null fields omitted
  });

  it("prints only `error` on failure (with hint when available)", async () => {
    setApiForTesting(stubApi());
    // Emoji ref without a seq → error carries a recovery hint
    await main(["message", "emoji", "--target", "/s/general", "--emoji", "👍"]);
    const env = parseEnvelope(cap.lines());
    expect(typeof env.error).toBe("string");
    expect("success" in env).toBe(false);
    expect("hint" in env).toBe(true);
  });

  it("always exits 0 even on error", async () => {
    setApiForTesting(stubApi());
    const code = await main(["bogus", "command"]);
    expect(code).toBe(0);
    expect(parseEnvelope(cap.lines()).error).toContain("unknown command");
  });

  it("surfaces a readable error when no API is available", async () => {
    // No setApiForTesting + no proxy env → getApi throws a CliError.
    await main(["inbox", "pull"]);
    expect(parseEnvelope(cap.lines()).error).toContain("no ServerApi available");
  });

  it("`-h` prints PLAIN TEXT usage, NOT a JSON envelope (Gus 架构#473)", async () => {
    const code = await main(["-h"]);
    expect(code).toBe(0);
    const out = cap.lines().join("");
    // Human usage text — commander's help, not `{"success":{"usage":…}}`.
    expect(out).toContain("Usage:");
    expect(out.trimStart().startsWith("{")).toBe(false); // not JSON
    expect(() => JSON.parse(out)).toThrow(); // definitively not the envelope
  });

  it("a subcommand `-h` is also plain text", async () => {
    await main(["message", "-h"]);
    const out = cap.lines().join("");
    expect(out).toContain("Usage:");
    expect(out.trimStart().startsWith("{")).toBe(false);
  });

  it("BOUNDARY: normal commands + errors still emit JSON (only -h is text)", async () => {
    // Guard Gus's caveat (#477): the -h→text change must NOT bleed into the
    // JSON output every other command/agent path depends on.
    setApiForTesting(stubApi());
    await main(["bogus", "command"]); // unknownCommand → still JSON
    const env = parseEnvelope(cap.lines()); // parseEnvelope asserts exactly one JSON line
    expect(env.error).toContain("unknown command");
  });
});

describe("channel alignment (message send)", () => {
  it("blocked send becomes a readable error telling the agent to pull", async () => {
    setApiForTesting(
      stubApi({ send: async () => ({ state: "blocked", reason: "unaligned", unreadCount: 3, latestSeq: 12 }) }),
    );
    await main(["message", "send", "--target", "/s/general", "--text", "hi"]);
    const env = parseEnvelope(cap.lines());
    expect("success" in env).toBe(false);
    expect(env.error).toContain("not aligned");
    expect(env.error).toContain("3 unread");
    expect(env.error).toContain("#12");
    expect(env.error).toContain("inbox pull");
  });
});

describe("message send --reply", () => {
  it("strips a leading # from --reply and forwards replyToSeq", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#8", channel: "/s/general", sender: "@a", content: { text: "on it" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s/general", "--text", "on it", "--reply", "#37"]);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ replyToSeq: 37 }));
  });

  it("accepts a bare numeric --reply", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#8", channel: "/s/general", sender: "@a", content: { text: "on it" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s/general", "--text", "on it", "--reply", "37"]);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ replyToSeq: 37 }));
  });

  it("omits replyToSeq (undefined) when --reply is absent", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#8", channel: "/s/general", sender: "@a", content: { text: "hi" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s/general", "--text", "hi"]);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ replyToSeq: undefined }));
  });

  it("rejects a non-numeric --reply with a CliError, never calling send", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#8", channel: "/s/general", sender: "@a", content: { text: "" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s/general", "--text", "hi", "--reply", "x"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("--reply must be a message seq");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects --reply 0 (not a real seq) with a CliError", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#8", channel: "/s/general", sender: "@a", content: { text: "" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s/general", "--text", "hi", "--reply", "0"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("--reply must be a message seq");
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("inbox pull", () => {
  it("acks by default and returns messages in success", async () => {
    const ackSpy = vi.fn(async () => undefined);
    setApiForTesting(
      stubApi({
        inboxPull: async () => ({
          messages: [{ seq: "#2", channel: "/s/general", sender: "@x", content: { text: "yo" }, time: "" }],
          hasMore: false,
        }),
        ack: ackSpy,
      }),
    );
    await main(["inbox", "pull"]);
    const env = parseEnvelope(cap.lines()) as {
      success: { acked: number; messages: unknown[]; pulledAt: string };
    };
    expect(ackSpy).toHaveBeenCalledOnce();
    expect(env.success.acked).toBe(1);
    expect(env.success.messages).toHaveLength(1);
    expect(env.success.pulledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it("--no-ack skips advancing the waterline", async () => {
    const ackSpy = vi.fn(async () => undefined);
    setApiForTesting(
      stubApi({
        inboxPull: async () => ({
          messages: [{ seq: "#2", channel: "/s/general", sender: "@x", content: { text: "yo" }, time: "" }],
          hasMore: false,
        }),
        ack: ackSpy,
      }),
    );
    await main(["inbox", "pull", "--no-ack"]);
    const env = parseEnvelope(cap.lines()) as { success: { acked: number } };
    expect(ackSpy).not.toHaveBeenCalled();
    expect(env.success.acked).toBe(0);
  });

  it("surfaces ackError instead of poisoning the whole pull when ack throws", async () => {
    // Regression guard for Mellicent's dead-loop: ack failing on ONE cursor
    // used to collapse the whole envelope to `{"error":"forbidden"}`, wiping
    // the messages the agent needed to see. The pull envelope must retain
    // its messages AND report `ackError` distinctly.
    const ackSpy = vi.fn(async () => {
      throw new Error("forbidden");
    });
    setApiForTesting(
      stubApi({
        inboxPull: async () => ({
          messages: [
            { seq: "#2", channel: "/s/general", sender: "@x", content: { text: "hi" }, time: "" },
            { seq: "#3", channel: "/s/general", sender: "@x", content: { text: "bye" }, time: "" },
          ],
          hasMore: false,
        }),
        ack: ackSpy,
      }),
    );
    await main(["inbox", "pull"]);
    const env = parseEnvelope(cap.lines()) as {
      success: { acked: number; messages: unknown[]; ackError?: string };
    };
    expect(ackSpy).toHaveBeenCalledOnce();
    expect(env.success.messages).toHaveLength(2);
    expect(env.success.acked).toBe(0);
    expect(env.success.ackError).toBe("forbidden");
  });

  it("does NOT include ackError when the ack succeeds", async () => {
    setApiForTesting(
      stubApi({
        inboxPull: async () => ({
          messages: [{ seq: "#2", channel: "/s/general", sender: "@x", content: { text: "yo" }, time: "" }],
          hasMore: false,
        }),
        ack: async () => undefined,
      }),
    );
    await main(["inbox", "pull"]);
    const env = parseEnvelope(cap.lines()) as {
      success: { acked: number; ackError?: string };
    };
    expect(env.success.acked).toBe(1);
    expect(env.success.ackError).toBeUndefined();
  });
});

describe("message send — idempotent retry (mutation-idempotency ②)", () => {
  const okRes = {
    state: "sent" as const,
    message: { seq: "#8", channel: "/s/general", sender: "@a", content: { text: "hi" }, time: "" },
  };

  it("attaches a nonce to the send request", async () => {
    const sendSpy = vi.fn(async () => okRes);
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s/general", "--text", "hi"]);
    const arg = sendSpy.mock.calls[0]![0] as { nonce?: string };
    expect(typeof arg.nonce).toBe("string");
    expect((arg.nonce ?? "").length).toBeGreaterThan(0);
  });

  it("retries a transient upstream 5xx and reuses the SAME nonce, then succeeds (no duplicate surfaced)", async () => {
    let calls = 0;
    const nonces: (string | undefined)[] = [];
    const sendSpy = vi.fn(async (req: { nonce?: string }) => {
      nonces.push(req.nonce);
      calls++;
      if (calls === 1) throw new Error("upstream returned 502 with non-JSON body from /api/send");
      return okRes;
    });
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s/general", "--text", "hi"]);
    const env = parseEnvelope(cap.lines());
    expect(env.success.sent).toBe("/s/general#8"); // succeeded, not an error
    expect(calls).toBe(2); // retried once
    expect(nonces[0]).toBe(nonces[1]); // SAME nonce across the retry — server can dedupe
  });

  it("treats a `deduped` success (same-nonce retry matched the committed message) as sent, not an error", async () => {
    const sendSpy = vi.fn(async () => ({ ...okRes, deduped: true }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s/general", "--text", "hi"]);
    const env = parseEnvelope(cap.lines());
    expect(env.success.sent).toBe("/s/general#8");
    expect(env.error).toBeUndefined();
  });

  it("does NOT retry a blocked/unaligned business outcome (it's a return, not transient)", async () => {
    const sendSpy = vi.fn(async () => ({ state: "blocked" as const, reason: "unaligned" as const, unreadCount: 2, latestSeq: 9 }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s/general", "--text", "hi"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("channel not aligned");
    expect(sendSpy).toHaveBeenCalledTimes(1); // no retry on a business outcome
  });

  it("does NOT retry a non-transient thrown error (e.g. 4xx), surfaces it once", async () => {
    const sendSpy = vi.fn(async () => { throw new Error("reply target #5 not found in /s/general"); });
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s/general", "--text", "hi"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("reply target");
    expect(sendSpy).toHaveBeenCalledTimes(1); // deterministic business error — not retried
  });
});

describe("message post", () => {
  const okRes = { ref: "/s/ideas/my-post", name: "my-post", seq: 1 };

  it("forwards forum ref + title + body, returns the canonical post ref", async () => {
    const postSpy = vi.fn(async () => okRes);
    setApiForTesting(stubApi({ createPost: postSpy }));
    await main(["message", "post", "--target", "/s/ideas", "--title", "My Post", "--text", "hello"]);
    const env = parseEnvelope(cap.lines());
    expect(env.success.posted).toBe("/s/ideas/my-post");
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({ forum: "/s/ideas", title: "My Post", content: { text: "hello" } }),
    );
  });

  it("requires --target (forum ref), never calling createPost", async () => {
    const postSpy = vi.fn(async () => okRes);
    setApiForTesting(stubApi({ createPost: postSpy }));
    await main(["message", "post", "--title", "My Post", "--text", "hi"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("--target");
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("requires --title, never calling createPost", async () => {
    const postSpy = vi.fn(async () => okRes);
    setApiForTesting(stubApi({ createPost: postSpy }));
    await main(["message", "post", "--target", "/s/ideas", "--text", "hi"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("--title");
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("requires text OR an attachment (empty opener → error, never calls createPost)", async () => {
    const postSpy = vi.fn(async () => okRes);
    setApiForTesting(stubApi({ createPost: postSpy }));
    await main(["message", "post", "--target", "/s/ideas", "--title", "My Post"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("--text");
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("allows an attachment-only post (no --text)", async () => {
    const postSpy = vi.fn(async () => okRes);
    setApiForTesting(stubApi({ createPost: postSpy }));
    await main(["message", "post", "--target", "/s/ideas", "--title", "My Post", "--attachment", "att_1"]);
    const env = parseEnvelope(cap.lines());
    expect(env.success.posted).toBe("/s/ideas/my-post");
    expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ attachments: ["att_1"] }));
  });

  it("attaches a nonce and reuses it across a transient-5xx retry (no duplicate post)", async () => {
    let calls = 0;
    const nonces: (string | undefined)[] = [];
    const postSpy = vi.fn(async (req: { nonce?: string }) => {
      nonces.push(req.nonce);
      calls++;
      if (calls === 1) throw new Error("upstream returned 502 with non-JSON body from /api/createPost");
      return okRes;
    });
    setApiForTesting(stubApi({ createPost: postSpy }));
    await main(["message", "post", "--target", "/s/ideas", "--title", "My Post", "--text", "hi"]);
    const env = parseEnvelope(cap.lines());
    expect(env.success.posted).toBe("/s/ideas/my-post");
    expect(calls).toBe(2);
    expect(nonces[0]).toBe(nonces[1]); // same nonce → server dedupes, no second post
  });
});

describe("server list", () => {
  it("prints {success:{servers:[...]}} from a stubbed listServers", async () => {
    setApiForTesting(
      stubApi({ listServers: async () => ({ servers: [{ id: "srv_1", name: "Design Studio" }] }) }),
    );
    await main(["server", "list"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { servers: [{ id: "srv_1", name: "Design Studio" }] } });
  });

  it("prints an empty array when the bot is in no servers", async () => {
    setApiForTesting(stubApi({ listServers: async () => ({ servers: [] }) }));
    await main(["server", "list"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { servers: [] } });
  });
});

describe("server member", () => {
  it("prints {success:{members, cursor, hasMore}} from a stubbed listMembers", async () => {
    const listMembersSpy = vi.fn(async () => ({
      members: [{ handle: "gustavo#4821", role: "owner", online: true, status: { emoji: "🍜", text: "lunch" } }],
      cursor: "2026-01-01T00:00:00Z|sm_1",
      hasMore: true,
    }));
    setApiForTesting(stubApi({ listMembers: listMembersSpy }));
    await main(["server", "member", "--server", "Design Studio", "--limit", "1", "--cursor", "c0"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({
      success: {
        members: [{ handle: "gustavo#4821", role: "owner", online: true, status: { emoji: "🍜", text: "lunch" } }],
        cursor: "2026-01-01T00:00:00Z|sm_1",
        hasMore: true,
      },
    });
    // limit coerced to a number; opaque cursor round-tripped verbatim.
    expect(listMembersSpy).toHaveBeenCalledWith(
      expect.objectContaining({ server: "Design Studio", limit: 1, cursor: "c0" }),
    );
  });

  it("rejects a non-positive-integer --limit with a clear error, listMembers never called", async () => {
    const listMembersSpy = vi.fn(async () => ({ members: [], hasMore: false }));
    setApiForTesting(stubApi({ listMembers: listMembersSpy }));
    await main(["server", "member", "--server", "Design Studio", "--limit", "abc"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "server member: --limit must be a positive integer" });
    expect(listMembersSpy).not.toHaveBeenCalled();
  });

  it("missing --server → error, listMembers never called", async () => {
    const listMembersSpy = vi.fn(async () => ({ members: [], hasMore: false }));
    setApiForTesting(stubApi({ listMembers: listMembersSpy }));
    await main(["server", "member"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "server member: --server <name> is required" });
    expect(listMembersSpy).not.toHaveBeenCalled();
  });

  it("surfaces an ambiguous-name error verbatim as {error: <message>}", async () => {
    const message = 'ambiguous server name "studio" — matches 2 servers: srv_1 ("Design Studio"), srv_2 ("Studio Ops")';
    setApiForTesting(
      stubApi({
        listMembers: async () => {
          throw new Error(message);
        },
      }),
    );
    await main(["server", "member", "--server", "studio"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: message });
    expect("hint" in env).toBe(false);
  });
});

describe("server join", () => {
  it("extracts the token from a full URL and calls joinServer with the bare token only", async () => {
    const joinServerSpy = vi.fn(async () => ({ server: { id: "srv_1", name: "Design Studio" } }));
    setApiForTesting(stubApi({ joinServer: joinServerSpy }));
    await main(["server", "join", "--invite", "https://alook.dev/c/invite/AbC123XyZ0"]);
    expect(joinServerSpy).toHaveBeenCalledWith(expect.objectContaining({ invite: "AbC123XyZ0" }));
  });

  it("passes a bare token through unchanged", async () => {
    const joinServerSpy = vi.fn(async () => ({ server: { id: "srv_1", name: "Design Studio" } }));
    setApiForTesting(stubApi({ joinServer: joinServerSpy }));
    await main(["server", "join", "--invite", "AbC123XyZ0"]);
    expect(joinServerSpy).toHaveBeenCalledWith(expect.objectContaining({ invite: "AbC123XyZ0" }));
  });

  it("missing --invite → error", async () => {
    setApiForTesting(stubApi());
    await main(["server", "join"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "server join: --invite <link> is required" });
  });

  it("unparseable --invite value → descriptive error, joinServer never called", async () => {
    const joinServerSpy = vi.fn(async () => ({ server: { id: "srv_1", name: "Design Studio" } }));
    setApiForTesting(stubApi({ joinServer: joinServerSpy }));
    await main(["server", "join", "--invite", "not an invite at all"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("could not find an invite token");
    expect(joinServerSpy).not.toHaveBeenCalled();
  });

  it("a thrown rejection (not found / expired / already a member / owner mismatch) surfaces as {error: <message>}", async () => {
    setApiForTesting(
      stubApi({
        joinServer: async () => {
          throw new Error("Already a member");
        },
      }),
    );
    await main(["server", "join", "--invite", "AbC123XyZ0"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "Already a member" });
  });

  it("a thrown error carrying .hint prints {error, hint}", async () => {
    setApiForTesting(
      stubApi({
        joinServer: async () => {
          const err = new Error("This invite was not created by your owner — refusing to join.");
          (err as { hint?: string }).hint = "Ask your owner to send an invite link they created themselves.";
          throw err;
        },
      }),
    );
    await main(["server", "join", "--invite", "AbC123XyZ0"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({
      error: "This invite was not created by your owner — refusing to join.",
      hint: "Ask your owner to send an invite link they created themselves.",
    });
  });

  it("success prints {success:{server:{id,name}}} (no `joined` key)", async () => {
    setApiForTesting(
      stubApi({ joinServer: async () => ({ server: { id: "srv_1", name: "Design Studio" } }) }),
    );
    await main(["server", "join", "--invite", "AbC123XyZ0"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { server: { id: "srv_1", name: "Design Studio" } } });
    expect(env.success as object).not.toHaveProperty("joined");
  });
});

describe("channel list", () => {
  it("prints {success:{groups:[...]}} from a stubbed listChannels", async () => {
    const listChannelsSpy = vi.fn(async () => ({
      groups: [
        {
          category: null,
          channels: [
            { ref: "/demo-workspace/announcements", name: "announcements", type: "text" as const, visibility: "public" as const },
          ],
        },
        {
          category: { name: "Ops", private: false },
          channels: [
            { ref: "/demo-workspace/general", name: "general", type: "text" as const, visibility: "public" as const },
            { ref: "/demo-workspace/help", name: "help", type: "forum" as const, visibility: "public" as const },
          ],
        },
      ],
    }));
    setApiForTesting(stubApi({ listChannels: listChannelsSpy }));
    await main(["channel", "list", "--server", "srv_8fk2"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({
      success: {
        groups: [
          {
            category: null,
            channels: [
              { ref: "/demo-workspace/announcements", name: "announcements", type: "text", visibility: "public" },
            ],
          },
          {
            category: { name: "Ops", private: false },
            channels: [
              { ref: "/demo-workspace/general", name: "general", type: "text", visibility: "public" },
              { ref: "/demo-workspace/help", name: "help", type: "forum", visibility: "public" },
            ],
          },
        ],
      },
    });
    expect(listChannelsSpy).toHaveBeenCalledWith(expect.objectContaining({ server: "srv_8fk2" }));
  });

  it("--server accepts a name and passes it straight through unmodified", async () => {
    const listChannelsSpy = vi.fn(async () => ({ groups: [] }));
    setApiForTesting(stubApi({ listChannels: listChannelsSpy }));
    await main(["channel", "list", "--server", "Design Studio"]);
    expect(listChannelsSpy).toHaveBeenCalledWith(expect.objectContaining({ server: "Design Studio" }));
  });

  it("surfaces an ambiguous-name error verbatim as {error: <message>}", async () => {
    const message = 'ambiguous server name "studio" — matches 2 servers: srv_1 ("Design Studio"), srv_2 ("Studio Ops")';
    setApiForTesting(
      stubApi({
        listChannels: async () => {
          throw new Error(message);
        },
      }),
    );
    await main(["channel", "list", "--server", "studio"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: message });
  });

  it("--server matching no server surfaces a readable error", async () => {
    setApiForTesting(
      stubApi({
        listChannels: async () => {
          throw new Error("server not found: Nope");
        },
      }),
    );
    await main(["channel", "list", "--server", "Nope"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("server not found");
  });

  it("missing --server → CLI error, no API call made", async () => {
    const listChannelsSpy = vi.fn(async () => ({ groups: [] }));
    setApiForTesting(stubApi({ listChannels: listChannelsSpy }));
    await main(["channel", "list"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "channel list: --server <id-or-name> is required" });
    expect(listChannelsSpy).not.toHaveBeenCalled();
  });

  it("empty channel list → {success:{groups:[]}}, not an error", async () => {
    setApiForTesting(stubApi({ listChannels: async () => ({ groups: [] }) }));
    await main(["channel", "list", "--server", "srv_1"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { groups: [] } });
  });
});

describe("channel member", () => {
  it("prints {success:{visibility:'public',hint:'...'}} for a public channel", async () => {
    const channelMemberSpy = vi.fn(async () => ({
      visibility: "public" as const,
      hint: "This channel is public. Use `alook server member --server demo` to list who can see it.",
    }));
    setApiForTesting(stubApi({ channelMember: channelMemberSpy }));
    await main(["channel", "member", "--channel", "/demo/general"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({
      success: {
        visibility: "public",
        hint: "This channel is public. Use `alook server member --server demo` to list who can see it.",
      },
    });
    expect(channelMemberSpy).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "/demo/general" }),
    );
  });

  it("prints {success:{visibility:'private',members:[...]}} for a private channel", async () => {
    const channelMemberSpy = vi.fn(async () => ({
      visibility: "private" as const,
      members: [
        { handle: "gustavo#4821", role: "owner", nickname: "Gus" },
        { handle: "alice#0193", role: "member" },
      ],
    }));
    setApiForTesting(stubApi({ channelMember: channelMemberSpy }));
    await main(["channel", "member", "--channel", "/demo/leadership"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({
      success: {
        visibility: "private",
        members: [
          { handle: "gustavo#4821", role: "owner", nickname: "Gus" },
          { handle: "alice#0193", role: "member" },
        ],
      },
    });
  });

  it("thread ref passes through unchanged", async () => {
    const channelMemberSpy = vi.fn(async () => ({ visibility: "private" as const, members: [] }));
    setApiForTesting(stubApi({ channelMember: channelMemberSpy }));
    await main(["channel", "member", "--channel", "/demo/general/#12"]);
    expect(channelMemberSpy).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "/demo/general/#12" }),
    );
  });

  it("missing --channel → CLI error, no API call made", async () => {
    const channelMemberSpy = vi.fn(async () => ({ visibility: "public" as const, hint: "" }));
    setApiForTesting(stubApi({ channelMember: channelMemberSpy }));
    await main(["channel", "member"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "channel member: --channel <ref> is required" });
    expect(channelMemberSpy).not.toHaveBeenCalled();
  });

  it("DM ref rejected server-side surfaces as {error: <message>}", async () => {
    setApiForTesting(
      stubApi({
        channelMember: async () => {
          throw new Error("channel member is channel-scoped — DM refs are not supported");
        },
      }),
    );
    await main(["channel", "member", "--channel", "/.dm/peer#0042"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "channel member is channel-scoped — DM refs are not supported" });
  });
});

describe("channel history", () => {
  it("missing --channel → CLI error, no API call made", async () => {
    const readSpy = vi.fn(async () => ({ items: [], hasMore: false }));
    setApiForTesting(stubApi({ read: readSpy }));
    await main(["channel", "history"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "channel history: --channel <ref> is required" });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("passes --before/--after/--around/--limit through to api.read() untouched", async () => {
    const readSpy = vi.fn(async () => ({ items: [], hasMore: false }));
    setApiForTesting(stubApi({ read: readSpy }));
    await main([
      "channel", "history", "--channel", "/demo-workspace/general",
      "--before", "42", "--after", "1", "--around", "20", "--limit", "5",
    ]);
    expect(readSpy).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "/demo-workspace/general", before: 42, after: 1, around: 20, limit: 5 }),
    );
  });

  it("response shape is {items,hasMore,latestSeq?} — omits latestSeq when absent", async () => {
    setApiForTesting(
      stubApi({
        read: async () => ({
          items: [{ seq: "#37", channel: "/s/general", sender: "@a", content: { text: "hi" }, time: "" }],
          hasMore: true,
        }),
      }),
    );
    await main(["channel", "history", "--channel", "/s/general"]);
    const env = parseEnvelope(cap.lines()) as { success: { items: unknown[]; hasMore: boolean } };
    expect(env.success.hasMore).toBe(true);
    expect(env.success.items).toHaveLength(1);
    expect("latestSeq" in env.success).toBe(false);
  });

  it("includes latestSeq when the API returns one", async () => {
    setApiForTesting(stubApi({ read: async () => ({ items: [], hasMore: false, latestSeq: 41 }) }));
    await main(["channel", "history", "--channel", "/s/general"]);
    const env = parseEnvelope(cap.lines()) as { success: { latestSeq: number } };
    expect(env.success.latestSeq).toBe(41);
  });

  it("works for a thread ref — passes it through to api.read() unmodified", async () => {
    const readSpy = vi.fn(async () => ({ items: [], hasMore: false }));
    setApiForTesting(stubApi({ read: readSpy }));
    await main(["channel", "history", "--channel", "/demo-workspace/general/#12"]);
    expect(readSpy).toHaveBeenCalledWith(expect.objectContaining({ channel: "/demo-workspace/general/#12" }));
  });

  it("works for a DM ref — passes it through to api.read() unmodified", async () => {
    const readSpy = vi.fn(async () => ({ items: [], hasMore: false }));
    setApiForTesting(stubApi({ read: readSpy }));
    await main(["channel", "history", "--channel", "/.dm/gustavo#4821", "--limit", "20"]);
    expect(readSpy).toHaveBeenCalledWith(expect.objectContaining({ channel: "/.dm/gustavo#4821", limit: 20 }));
  });

  it("API error (e.g. channel not found) surfaces as {error, hint?}", async () => {
    setApiForTesting(
      stubApi({
        read: async () => {
          throw new Error("channel not found: /s/nope");
        },
      }),
    );
    await main(["channel", "history", "--channel", "/s/nope"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "channel not found: /s/nope" });
  });
});

describe("message emoji", () => {
  it("channel ref — calls reactAdd with (channel, seq, emoji) and prints success envelope", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo/general#42", "--emoji", "👍"]);
    expect(reactAddSpy).toHaveBeenCalledWith({ channel: "/demo/general", seq: 42, emoji: "👍" });
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { target: "/demo/general#42", emoji: "👍", duplicate: false } });
  });

  it("DM ref — calls reactAdd with the DM channel + seq split out", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/.dm/peer#0001#7", "--emoji", "🙏"]);
    expect(reactAddSpy).toHaveBeenCalledWith({ channel: "/.dm/peer#0001", seq: 7, emoji: "🙏" });
  });

  it("forum-post ref — reacts to a message INSIDE the post (childChannelName kept, not the parent forum)", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo/ideas/my-post#4", "--emoji", "👍"]);
    // channel is the POST scope (/demo/ideas/my-post), NOT the parent forum /demo/ideas.
    expect(reactAddSpy).toHaveBeenCalledWith({ channel: "/demo/ideas/my-post", seq: 4, emoji: "👍" });
  });

  it("forum-post ref without a message seq → error, reactAdd never called", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo/ideas/my-post", "--emoji", "👍"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toMatch(/needs a ref with a seq/);
    expect(reactAddSpy).not.toHaveBeenCalled();
  });

  it("proxy error surfaces .hint alongside .error and reactAdd throws propagate", async () => {
    setApiForTesting(
      stubApi({
        reactAdd: async () => {
          const err = new Error("not a member of #general");
          (err as { hint?: string }).hint = "join the channel first";
          throw err;
        },
      }),
    );
    await main(["message", "emoji", "--target", "/demo/general#42", "--emoji", "👍"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "not a member of #general", hint: "join the channel first" });
  });

  it("thread scope ref without message seq → error, reactAdd never called", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo/general/#5", "--emoji", "👍"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toMatch(/needs a ref with a seq/);
    expect(env.hint).toMatch(/#N#M/);
    expect(reactAddSpy).not.toHaveBeenCalled();
  });

  it("bare channel ref (no #N) → error envelope with seq hint, reactAdd never called", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo/general", "--emoji", "👍"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toMatch(/needs a ref with a seq/);
    expect(env.hint).toMatch(/#N/);
    expect(reactAddSpy).not.toHaveBeenCalled();
  });

  it("missing --target → commander error, reactAdd never called", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--emoji", "👍"]);
    const env = parseEnvelope(cap.lines());
    expect("error" in env).toBe(true);
    expect(reactAddSpy).not.toHaveBeenCalled();
  });

  it("missing --emoji → commander error, reactAdd never called", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo/general#42"]);
    const env = parseEnvelope(cap.lines());
    expect("error" in env).toBe(true);
    expect(reactAddSpy).not.toHaveBeenCalled();
  });

  it("oversize emoji → error envelope, reactAdd never called", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    const big = "🎉".repeat(20);
    await main(["message", "emoji", "--target", "/demo/general#42", "--emoji", big]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toMatch(/too long/);
    expect(env.hint).toMatch(/single emoji/);
    expect(reactAddSpy).not.toHaveBeenCalled();
  });

  it("duplicate — envelope surfaces duplicate:true, exit code still 0", async () => {
    setApiForTesting(stubApi({ reactAdd: async () => ({ ok: true as const, duplicate: true }) }));
    const code = await main(["message", "emoji", "--target", "/demo/general#42", "--emoji", "👍"]);
    expect(code).toBe(0);
    const env = parseEnvelope(cap.lines()) as { success: { duplicate: boolean } };
    expect(env.success.duplicate).toBe(true);
  });

  it("thread-reply ref — calls reactAdd with thread-scope channel + seq split out", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo/general/#5#42", "--emoji", "👍"]);
    expect(reactAddSpy).toHaveBeenCalledWith({ channel: "/demo/general/#5", seq: 42, emoji: "👍" });
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { target: "/demo/general/#5#42", emoji: "👍", duplicate: false } });
  });

  it("thread ROOT via parent channel ref (regression) unchanged", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo/general#5", "--emoji", "👀"]);
    expect(reactAddSpy).toHaveBeenCalledWith({ channel: "/demo/general", seq: 5, emoji: "👀" });
  });

  it("thread-reply oversize emoji still hits the local check before the wire", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    const big = "🎉".repeat(20);
    await main(["message", "emoji", "--target", "/demo/general/#5#42", "--emoji", big]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toMatch(/too long/);
    expect(reactAddSpy).not.toHaveBeenCalled();
  });

  it("thread-reply duplicate — envelope surfaces duplicate:true", async () => {
    setApiForTesting(stubApi({ reactAdd: async () => ({ ok: true as const, duplicate: true }) }));
    await main(["message", "emoji", "--target", "/demo/general/#5#42", "--emoji", "👍"]);
    const env = parseEnvelope(cap.lines()) as { success: { duplicate: boolean } };
    expect(env.success.duplicate).toBe(true);
  });
});

describe("channel subscribe removed", () => {
  it("`channel subscribe ...` is no longer a recognized command", async () => {
    setApiForTesting(stubApi());
    await main(["channel", "subscribe", "mentions", "--channel", "/x/y"]);
    const env = parseEnvelope(cap.lines());
    expect("error" in env).toBe(true);
    expect(env.error).toContain("unknown command");
  });
});

describe("import side effects", () => {
  it("importing ./index does not invoke main() — guard evaluates false under vitest", async () => {
    const commander = await import("commander");
    const parseSpy = vi.spyOn(commander.Command.prototype, "parseAsync");
    vi.resetModules();
    try {
      await import("./index");
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });
});

describe("friend request", () => {
  it("prints the pending variant of the discriminated union verbatim", async () => {
    const friendRequestSpy = vi.fn(async () => ({
      friendshipId: "fr_1",
      status: "pending" as const,
      hint: "Your owner Bob needs to approve this request in DM.",
    }));
    setApiForTesting(stubApi({ friendRequest: friendRequestSpy }));
    await main(["friend", "request", "--username", "Alice#0042"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({
      success: {
        friendshipId: "fr_1",
        status: "pending",
        hint: "Your owner Bob needs to approve this request in DM.",
      },
    });
    expect(friendRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ username: "Alice#0042" }),
    );
  });

  it("passes the sibling-accept variant through untouched (hint: null not collapsed)", async () => {
    setApiForTesting(
      stubApi({
        friendRequest: async () => ({ friendshipId: "fr_2", status: "accepted" as const, hint: null }),
      }),
    );
    await main(["friend", "request", "--username", "Yara#0042"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { friendshipId: "fr_2", status: "accepted", hint: null } });
  });

  it("missing --username → error envelope, friendRequest never called", async () => {
    const friendRequestSpy = vi.fn(async () => ({ friendshipId: "x", status: "pending" as const, hint: "h" }));
    setApiForTesting(stubApi({ friendRequest: friendRequestSpy }));
    await main(["friend", "request"]);
    const env = parseEnvelope(cap.lines());
    expect(typeof env.error).toBe("string");
    expect(env.error).toContain("--username");
    expect(friendRequestSpy).not.toHaveBeenCalled();
  });

  it("surfaces code on an already_friends rejection, still one JSON line", async () => {
    const err = new Error("already friends") as Error & { code?: string };
    err.code = "already_friends";
    setApiForTesting(stubApi({ friendRequest: async () => { throw err; } }));
    await main(["friend", "request", "--username", "Bob#0042"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toBeDefined();
    expect(env.code).toBe("already_friends");
    expect("success" in env).toBe(false);
  });

  it("surfaces code on a blocked rejection, still one JSON line", async () => {
    const err = new Error("blocked") as Error & { code?: string };
    err.code = "blocked";
    setApiForTesting(stubApi({ friendRequest: async () => { throw err; } }));
    await main(["friend", "request", "--username", "Yara#0042"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toBeDefined();
    expect(env.code).toBe("blocked");
  });
});

describe("friend list", () => {
  it("prints the three buckets from a stubbed listFriends", async () => {
    const listFriendsSpy = vi.fn(async () => ({
      accepted: [
        {
          userId: "u_alice",
          handle: "Alice#0042",
          name: "Alice",
          bio: null,
          statusText: null,
          statusEmoji: null,
          presence: "online" as const,
        },
      ],
      pendingOutgoing: [],
      pendingIncoming: [],
    }));
    setApiForTesting(stubApi({ listFriends: listFriendsSpy }));
    await main(["friend", "list"]);
    const env = parseEnvelope(cap.lines());
    expect(env.success).toMatchObject({
      accepted: [expect.objectContaining({ handle: "Alice#0042", presence: "online" })],
      pendingOutgoing: [],
      pendingIncoming: [],
    });
  });

  it("prints empty buckets as [] (not null) so the parser sees a stable shape", async () => {
    setApiForTesting(
      stubApi({
        listFriends: async () => ({ accepted: [], pendingOutgoing: [], pendingIncoming: [] }),
      }),
    );
    await main(["friend", "list"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { accepted: [], pendingOutgoing: [], pendingIncoming: [] } });
  });
});

describe("decodeTextEscapes", () => {
  it("decodes \\n to a real newline", () => {
    expect(decodeTextEscapes("a\\nb")).toBe("a\nb");
  });

  it("decodes \\n\\n to two newlines (the reported case)", () => {
    expect(decodeTextEscapes("a\\n\\nb")).toBe("a\n\nb");
  });

  it("decodes \\t and \\r", () => {
    expect(decodeTextEscapes("a\\tb\\rc")).toBe("a\tb\rc");
  });

  it("treats an escaped backslash as literal — \\\\n is NOT a newline (single-pass correctness)", () => {
    // Input chars: backslash, backslash, n  →  backslash, n (literal), no LF.
    expect(decodeTextEscapes("a\\\\nb")).toBe("a\\nb");
    expect(decodeTextEscapes("a\\\\nb")).not.toContain("\n");
  });

  it("passes an unknown escape through unchanged (backslash kept)", () => {
    expect(decodeTextEscapes("a\\qb")).toBe("a\\qb");
  });

  it("leaves a trailing lone backslash unchanged", () => {
    expect(decodeTextEscapes("ab\\")).toBe("ab\\");
  });

  it("leaves plain text (incl. UTF-8/emoji) untouched", () => {
    expect(decodeTextEscapes("总部 🎉 no escapes")).toBe("总部 🎉 no escapes");
  });
});

describe("message send — --text escape decoding wired end-to-end", () => {
  it("sends a real newline body for --text \"a\\n\\nb\"", async () => {
    let sentText: string | undefined;
    setApiForTesting(
      stubApi({
        send: async (input: Parameters<ServerApi["send"]>[0]) => {
          sentText = input.content.text;
          return { state: "sent", message: { seq: "#1", channel: "/s/c", sender: "@a", content: { text: "" }, time: "" } };
        },
      }),
    );
    // Two literal chars backslash-n twice, as a shell would pass them.
    await main(["message", "send", "--target", "/s/general", "--text", "a\\n\\nb"]);
    expect(sentText).toBe("a\n\nb");
    expect(sentText!.split("\n")).toHaveLength(3);
  });

  it("does NOT decode --file content (literal backslash-n stays literal)", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-esc-"));
    const file = path.join(dir, "body.txt");
    // File bytes contain a literal backslash + n (not a newline).
    fs.writeFileSync(file, "a\\nb");
    let sentText: string | undefined;
    setApiForTesting(
      stubApi({
        send: async (input: Parameters<ServerApi["send"]>[0]) => {
          sentText = input.content.text;
          return { state: "sent", message: { seq: "#1", channel: "/s/c", sender: "@a", content: { text: "" }, time: "" } };
        },
      }),
    );
    await main(["message", "send", "--target", "/s/general", "--file", file]);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(sentText).toBe("a\\nb");
    expect(sentText).not.toContain("\n");
  });
});

describe("nap", () => {
  it("errors when neither --handoff nor --text is given, and never calls api.nap", async () => {
    const napSpy = vi.fn(async () => ({ napped: true }));
    setApiForTesting(stubApi({ nap: napSpy }));
    await main(["nap"]);
    const env = parseEnvelope(cap.lines());
    expect(typeof env.error).toBe("string");
    expect(napSpy).not.toHaveBeenCalled();
  });

  it("errors on a whitespace-only --text handoff (mandatory, real handoff)", async () => {
    const napSpy = vi.fn(async () => ({ napped: true }));
    setApiForTesting(stubApi({ nap: napSpy }));
    await main(["nap", "--text", "   "]);
    const env = parseEnvelope(cap.lines());
    expect(typeof env.error).toBe("string");
    expect(napSpy).not.toHaveBeenCalled();
  });

  it("calls api.nap with the --text handoff (escapes decoded)", async () => {
    let handoff: string | undefined;
    setApiForTesting(
      stubApi({
        nap: async (r: Parameters<ServerApi["nap"]>[0]) => {
          handoff = r.handoff;
          return { napped: true };
        },
      }),
    );
    await main(["nap", "--text", "line1\\nline2"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { napped: true } });
    expect(handoff).toBe("line1\nline2");
  });

  it("reads the handoff from --handoff <file>", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nap-"));
    const file = path.join(dir, "handoff.md");
    fs.writeFileSync(file, "Was mid-review of PR #42; next: run QA.\n");
    let handoff: string | undefined;
    setApiForTesting(
      stubApi({
        nap: async (r: Parameters<ServerApi["nap"]>[0]) => {
          handoff = r.handoff;
          return { napped: true };
        },
      }),
    );
    await main(["nap", "--handoff", file]);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(handoff).toBe("Was mid-review of PR #42; next: run QA.");
  });
});
