import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { main, setApiForTesting } from "./index";
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
    read: async () => ({ items: [], hasMore: false }),
    resolve: async () => null,
    listMembers: async () => ({ members: [] }),
    joinServer: async () => ({ server: { id: "s", name: "s" } }),
    reactAdd: async () => ({ ok: true, duplicate: false }),
    ...over,
  } as ServerApi;
}

let cap: ReturnType<typeof captureStdout>;
beforeEach(() => {
  cap = captureStdout();
  process.env.ALOOK_AGENT_ID = "agent_test";
});
afterEach(() => {
  cap.restore();
  setApiForTesting(null);
  delete process.env.ALOOK_AGENT_ID;
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
    const code = await main(["message", "send", "--target", "/s/general", "--text", "hi", "--chaotic_level", "fine"]);
    const env = parseEnvelope(cap.lines());
    expect(code).toBe(0);
    expect(env).toEqual({ success: { sent: "/s/general#7" } });
    expect("error" in env).toBe(false);
    expect("hint" in env).toBe(false); // null fields omitted
  });

  it("prints only `error` on failure (with hint when available)", async () => {
    setApiForTesting(stubApi());
    // No --chaotic_level → error with hint
    await main(["message", "send", "--target", "/s/general", "--text", "hi"]);
    const env = parseEnvelope(cap.lines());
    expect(typeof env.error).toBe("string");
    expect(env.error).toContain("--chaotic_level");
    expect("success" in env).toBe(false);
    expect("hint" in env).toBe(true); // Chaos level errors include a hint
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
});

describe("channel alignment (message send)", () => {
  it("blocked send becomes a readable error telling the agent to pull", async () => {
    setApiForTesting(
      stubApi({ send: async () => ({ state: "blocked", reason: "unaligned", unreadCount: 3, latestSeq: 12 }) }),
    );
    await main(["message", "send", "--target", "/s/general", "--text", "hi", "--chaotic_level", "fine"]);
    const env = parseEnvelope(cap.lines());
    expect("success" in env).toBe(false);
    expect(env.error).toContain("not aligned");
    expect(env.error).toContain("3 unread");
    expect(env.error).toContain("#12");
    expect(env.error).toContain("inbox pull");
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
  it("prints {success:{members:[...]}} from a stubbed listMembers", async () => {
    const listMembersSpy = vi.fn(async () => ({
      members: [{ handle: "gustavo#4821", role: "owner" }],
    }));
    setApiForTesting(stubApi({ listMembers: listMembersSpy }));
    await main(["server", "member", "--server", "Design Studio"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { members: [{ handle: "gustavo#4821", role: "owner" }] } });
    expect(listMembersSpy).toHaveBeenCalledWith(
      expect.objectContaining({ server: "Design Studio" }),
    );
  });

  it("missing --server → error, listMembers never called", async () => {
    const listMembersSpy = vi.fn(async () => ({ members: [] }));
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
