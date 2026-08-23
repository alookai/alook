import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "node:stream";

const mockDaemonStart = vi.hoisted(() => vi.fn(async () => {}));
const mockDaemonStartById = vi.hoisted(() => vi.fn(async () => {}));
const mockDaemonReconnect = vi.hoisted(() => vi.fn(async () => {}));
const mockDaemonList = vi.hoisted(() => vi.fn(() => [{ id: "cm_saved_machine", pid: 42, alive: true, agents: 1, running: 0, lastActiveMs: 1 }]));
const mockDaemonRunFromIpc = vi.hoisted(() => vi.fn(async () => new Promise<never>(() => {})));
const mockArmMessageReminder = vi.hoisted(() => vi.fn(async () => ({ armed: true as const, dueAt: 123456 })));
vi.mock("./daemonStart", async (importOriginal) => ({
  ...await importOriginal<typeof import("./daemonStart")>(),
  daemonStart: mockDaemonStart,
  daemonStartById: mockDaemonStartById,
  daemonReconnect: mockDaemonReconnect,
  daemonList: mockDaemonList,
  daemonRunFromIpc: mockDaemonRunFromIpc,
}));
vi.mock("./messageReminderClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("./messageReminderClient")>(),
  armMessageReminderFromEnv: mockArmMessageReminder,
}));
import { main, setApiForTesting, decodeTextEscapes, type CliInputStream } from "./index";
import type { ServerApi } from "../server/contract";
import { MAX_SERVER_ICON_SIZE_BYTES } from "@alook/shared/constants/community";

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

function testStdin(text: string, isTTY = false): CliInputStream {
  const input = Readable.from([Buffer.from(text, "utf8")]) as CliInputStream;
  Object.defineProperty(input, "isTTY", { value: isTTY });
  return input;
}

function mainWithStdin(argv: string[], text = "hi", isTTY = false): Promise<number> {
  return main(argv, { stdin: testStdin(text, isTTY) });
}

/** Minimal ServerApi stub; override per test. */
function stubApi(over: Partial<ServerApi> = {}): ServerApi {
  return {
    listServers: async () => ({ servers: [] }),
    listChannels: async () => ({ groups: [] }),
    channelMember: async () => ({ visibility: "public", hint: "" }),
    inboxPull: async () => ({ messages: [], hasMore: false, markedCount: 0 }),
    inboxSnapshot: async () => ({ rows: [], pendingChannels: 0, pendingMessages: 0 }),
    ack: async (req) => ({ ok: true, applied: req.cursors, failed: [] }),
    send: async () => ({ state: "sent", message: { seq: "#1", channel: "/s/c", sender: "@a", content: { text: "" }, time: "" } }),
    read: async () => ({ items: [], hasMore: false }),
    resolve: async () => null,
    listMembers: async () => ({ members: [], hasMore: false }),
    joinServer: async () => ({ server: { handle: "s#0042" } }),
    reactAdd: async () => ({ ok: true, duplicate: false }),
    markSet: async () => undefined,
    markRemove: async () => undefined,
    listMarks: async () => ({ marked: [] }),
    friendRequest: async () => ({ friendshipId: "fr_1", status: "pending", hint: "Your owner needs to approve this request in DM." }),
    listFriends: async () => ({ accepted: [], pendingOutgoing: [], pendingIncoming: [] }),
    updateProfile: async (req) => ({
      updated: [req.avatar ? "avatar" as const : undefined, req.bio !== undefined ? "bio" as const : undefined]
        .filter((value): value is "avatar" | "bio" => value !== undefined),
      ...(req.bio !== undefined ? { bio: req.bio } : {}),
      ...(req.avatar ? { avatarUrl: "/api/community/bots/agent_test/avatar" } : {}),
    }),
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
  mockDaemonStart.mockClear();
  mockDaemonStartById.mockClear();
  mockDaemonReconnect.mockClear();
  mockDaemonRunFromIpc.mockClear();
  mockDaemonList.mockClear();
  process.env.ALOOK_AGENT_ID = "agent_test";
  savedProxyEnv = {};
  for (const k of PROXY_ENV_KEYS) {
    savedProxyEnv[k] = process.env[k];
    delete process.env[k];
  }
  mockArmMessageReminder.mockReset();
  mockArmMessageReminder.mockImplementation(async (input: { remindAfterMs: number }) =>
    input.remindAfterMs === 0
      ? { armed: false as const, reason: "disabled" }
      : { armed: true as const, dueAt: 123456 });
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

describe("daemon command contract", () => {
  it("starts in background by default and forwards foreground explicitly", async () => {
    await main(["daemon", "start", "--machine-key", "cmk_test", "--server-url", "http://server", "--ws-url", "ws://server"]);
    expect(mockDaemonStart).toHaveBeenLastCalledWith(expect.objectContaining({
      machineKey: "cmk_test",
      foreground: false,
    }));
    await main(["daemon", "start", "--foreground", "--machine-key", "cmk_test", "--server-url", "http://server", "--ws-url", "ws://server"]);
    expect(mockDaemonStart).toHaveBeenLastCalledWith(expect.objectContaining({
      machineKey: "cmk_test",
      foreground: true,
    }));
  });

  it("restarts a paired machine by id without accepting a machine key", async () => {
    await main(["daemon", "start", "--id", "cm_saved_machine", "--base-dir", "/tmp/alook-daemon"]);
    expect(mockDaemonStartById).toHaveBeenCalledWith({
      id: "cm_saved_machine",
      baseDir: "/tmp/alook-daemon",
      foreground: false,
    });
    expect(mockDaemonStart).not.toHaveBeenCalled();
  });

  it("reconnects only with an explicit machine id and cmt token", async () => {
    await main([
      "daemon",
      "reconnect",
      "--id",
      "cm_saved_machine",
      "--machine-key",
      "cmt_reconnect",
      "--base-dir",
      "/tmp/alook-daemon",
    ]);
    expect(mockDaemonReconnect).toHaveBeenCalledWith({
      id: "cm_saved_machine",
      machineKey: "cmt_reconnect",
      baseDir: "/tmp/alook-daemon",
      serverUrl: undefined,
      wsUrl: undefined,
    });
  });

  it("keeps missing and unknown arguments in the canonical Commander parser", async () => {
    await main(["daemon", "start"]);
    expect(parseEnvelope(cap.lines())).toEqual(expect.objectContaining({ error: expect.stringContaining("exactly one") }));
    cap.restore();
    cap = captureStdout();
    await main(["daemon", "start", "--machine-key", "cmk_test", "--id", "cm_saved_machine"]);
    expect(parseEnvelope(cap.lines())).toEqual(expect.objectContaining({ error: expect.stringContaining("exactly one") }));
    cap.restore();
    cap = captureStdout();
    await main(["daemon", "wat"]);
    expect(parseEnvelope(cap.lines())).toEqual(expect.objectContaining({ error: expect.stringContaining("unknown command") }));
  });

  it("lists daemons in a machine-readable envelope when requested", async () => {
    await main(["daemon", "list", "--json", "--base-dir", "/tmp/alook-daemon"]);
    expect(mockDaemonList).toHaveBeenCalledWith({ baseDir: "/tmp/alook-daemon" });
    expect(parseEnvelope(cap.lines())).toEqual({
      success: {
        daemons: [{ id: "cm_saved_machine", pid: 42, alive: true, agents: 1, running: 0, lastActiveMs: 1 }],
      },
    });
  });
});

describe("envelope contract", () => {
  it("prints exactly one JSON object with only `success` on success", async () => {
    setApiForTesting(
      stubApi({
        send: async () => ({
          state: "sent",
          message: { seq: "#7", channel: "/s#0042/general", sender: "@a", content: { text: "hi" }, time: "" },
        }),
      }),
    );
    const code = await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"]);
    const env = parseEnvelope(cap.lines());
    expect(code).toBe(0);
    expect(env).toEqual({
      success: {
        sent: "/s#0042/general#7",
        reminder: { armed: false, reason: "disabled" },
      },
    });
    expect("error" in env).toBe(false);
    expect("hint" in env).toBe(false); // null fields omitted
  });

  it("prints only `error` on failure (with hint when available)", async () => {
    setApiForTesting(stubApi());
    // Emoji ref without a seq → error carries a recovery hint
    await main(["message", "emoji", "--target", "/s#0042/general", "--emoji", "👍"]);
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
    expect(out).not.toMatch(/^\s+post\b/m);
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
  it("blocked send requires reading new messages before deciding whether to resend", async () => {
    setApiForTesting(
      stubApi({ send: async () => ({ state: "blocked", reason: "unaligned", unreadCount: 3, latestSeq: 12 }) }),
    );
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"]);
    const env = parseEnvelope(cap.lines());
    expect("success" in env).toBe(false);
    expect(env.error).toContain("not aligned");
    expect(env.error).toContain("3 unread");
    expect(env.error).toContain("#12");
    expect(env.error).toContain("inbox pull");
    expect(env.error).toContain("READ the new messages");
    expect(env.error).toContain("before deciding");
    expect(env.error).toContain("resend, adjust, or skip");
  });
});

describe("message send --remind-after", () => {
  const ok = {
    state: "sent" as const,
    message: { seq: "#7", channel: "/s#0042/general/#3", sender: "@a", content: { text: "hi" }, time: "" },
  };

  it("requires the flag before sending or making a local timer call", async () => {
    const send = vi.fn(async () => ok);
    setApiForTesting(stubApi({ send }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general/#3", "--stdin"]);
    expect(parseEnvelope(cap.lines()).error).toContain("--remind-after");
    expect(send).not.toHaveBeenCalled();
    expect(mockArmMessageReminder).not.toHaveBeenCalled();
  });

  it("sends with zero and clears using the server's canonical channel and seq", async () => {
    setApiForTesting(stubApi({ send: async () => ok }));
    await mainWithStdin([
      "message", "send", "--target", "/alias#0042/input", "--stdin", "--remind-after", "0",
    ]);
    expect(mockArmMessageReminder).toHaveBeenCalledWith({
      channel: "/s#0042/general/#3",
      sentSeq: 7,
      remindAfterMs: 0,
    });
    expect(parseEnvelope(cap.lines())).toEqual({
      success: {
        sent: "/s#0042/general/#3#7",
        reminder: { armed: false, reason: "disabled" },
      },
    });
  });

  it.each(["0m", "0h", "00", "25h", "1s", "1.5h"])("rejects invalid duration %s before sending", async (duration) => {
    const send = vi.fn(async () => ok);
    setApiForTesting(stubApi({ send }));
    await mainWithStdin([
      "message", "send", "--target", "/s#0042/general/#3", "--stdin", "--remind-after", duration,
    ]);
    expect(parseEnvelope(cap.lines()).error).toContain("--remind-after");
    expect(send).not.toHaveBeenCalled();
    expect(mockArmMessageReminder).not.toHaveBeenCalled();
  });

  it("arms only after success using the server's canonical channel and seq", async () => {
    setApiForTesting(stubApi({ send: async () => ok }));
    await mainWithStdin([
      "message", "send", "--target", "/alias#0042/input", "--stdin", "--remind-after", "2m",
    ]);
    expect(mockArmMessageReminder).toHaveBeenCalledWith({
      channel: "/s#0042/general/#3",
      sentSeq: 7,
      remindAfterMs: 120_000,
    });
    expect(parseEnvelope(cap.lines())).toEqual({
      success: {
        sent: "/s#0042/general/#3#7",
        reminder: { armed: true, dueAt: 123456 },
      },
    });
  });

  it("does not arm when send is blocked or throws", async () => {
    setApiForTesting(stubApi({
      send: async () => ({ state: "blocked", reason: "unaligned", unreadCount: 1, latestSeq: 9 }),
    }));
    await mainWithStdin([
      "message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "1m",
    ]);
    expect(mockArmMessageReminder).not.toHaveBeenCalled();

    cap.lines().length = 0;
    setApiForTesting(stubApi({ send: async () => { throw new Error("forbidden"); } }));
    await mainWithStdin([
      "message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "1m",
    ]);
    expect(mockArmMessageReminder).not.toHaveBeenCalled();
  });

  it("keeps sent success when local arming returns false or throws", async () => {
    setApiForTesting(stubApi({ send: async () => ok }));
    mockArmMessageReminder.mockResolvedValueOnce({ armed: false, reason: "newer_message_observed" });
    await mainWithStdin([
      "message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "1m",
    ]);
    expect(parseEnvelope(cap.lines())).toEqual({
      success: {
        sent: "/s#0042/general/#3#7",
        reminder: { armed: false, reason: "newer_message_observed" },
      },
    });

    cap.lines().length = 0;
    mockArmMessageReminder.mockRejectedValueOnce(new Error("vch_secret"));
    await mainWithStdin([
      "message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "1m",
    ]);
    const envelope = parseEnvelope(cap.lines());
    expect(envelope.success).toEqual({
      sent: "/s#0042/general/#3#7",
      reminder: { armed: false, reason: "local reminder request failed" },
    });
    expect(JSON.stringify(envelope)).not.toContain("vch_secret");
  });

  it("documents required zero-or-duration daemon-lifetime behavior in command help", async () => {
    await main(["message", "send", "-h"]);
    const output = cap.lines().join("");
    expect(output).toContain("--remind-after <0|Nm|Nh>");
    expect(output).toMatch(/required idle follow-up/);
    expect(output).toMatch(/0 disables/);
    expect(output).toMatch(/daemon\s+restart cancels it/);
  });
});

describe("message send --reply", () => {
  it("strips a leading # from --reply and forwards replyToSeq", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#8", channel: "/s#0042/general", sender: "@a", content: { text: "on it" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0", "--reply", "#37"], "on it");
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ replyToSeq: 37 }));
  });

  it("accepts a bare numeric --reply", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#8", channel: "/s#0042/general", sender: "@a", content: { text: "on it" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0", "--reply", "37"], "on it");
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ replyToSeq: 37 }));
  });

  it("omits replyToSeq (undefined) when --reply is absent", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#8", channel: "/s#0042/general", sender: "@a", content: { text: "hi" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"]);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ replyToSeq: undefined }));
  });

  it("rejects a non-numeric --reply with a CliError, never calling send", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#8", channel: "/s#0042/general", sender: "@a", content: { text: "" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0", "--reply", "x"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("--reply must be a message seq");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects --reply 0 (not a real seq) with a CliError", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#8", channel: "/s#0042/general", sender: "@a", content: { text: "" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0", "--reply", "0"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("--reply must be a message seq");
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("inbox pull", () => {
  it("never acks a rejected pull and only advances the returned cursor after repair", async () => {
    const ackSpy = vi.fn(async (req: { cursors: Array<{ channel: string; seq: number }> }) => ({
      ok: true, applied: req.cursors, failed: [],
    }));
    const pullSpy = vi.fn()
      .mockRejectedValueOnce(new Error("DM peer identity unavailable"))
      .mockResolvedValueOnce({
        messages: [{ seq: "#7", channel: "/.dm/Bob#0042", sender: "@Alice#1234", content: { text: "still owed" }, time: "" }],
        hasMore: false,
        markedCount: 0,
      });
    setApiForTesting(stubApi({ inboxPull: pullSpy, ack: ackSpy }));

    await main(["inbox", "pull"]);
    expect(parseEnvelope(cap.lines()).error).toContain("DM peer identity unavailable");
    expect(ackSpy).not.toHaveBeenCalled();

    cap.lines().length = 0;
    await main(["inbox", "pull"]);
    expect(ackSpy).toHaveBeenCalledOnce();
    expect(ackSpy).toHaveBeenCalledWith({
      agentId: expect.any(String),
      cursors: [{ channel: "/.dm/Bob#0042", seq: 7 }],
    });
  });

  it("acks by default and returns messages in success", async () => {
    const ackSpy = vi.fn(async (req: { cursors: Array<{ channel: string; seq: number }> }) => ({
      ok: true, applied: req.cursors, failed: [],
    }));
    setApiForTesting(
      stubApi({
        inboxPull: async () => ({
          messages: [{ seq: "#2", channel: "/s#0042/general", sender: "@x", content: { text: "yo" }, time: "" }],
          hasMore: false,
          markedCount: 0,
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
    const ackSpy = vi.fn(async (req: { cursors: Array<{ channel: string; seq: number }> }) => ({
      ok: true, applied: req.cursors, failed: [],
    }));
    setApiForTesting(
      stubApi({
        inboxPull: async () => ({
          messages: [{ seq: "#2", channel: "/s#0042/general", sender: "@x", content: { text: "yo" }, time: "" }],
          hasMore: false,
          markedCount: 0,
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
            { seq: "#2", channel: "/s#0042/general", sender: "@x", content: { text: "hi" }, time: "" },
            { seq: "#3", channel: "/s#0042/general", sender: "@x", content: { text: "bye" }, time: "" },
          ],
          hasMore: false,
          markedCount: 2,
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
    expect(Object.keys(env.success)).toEqual([
      "messages",
      "hasMore",
      "acked",
      "pulledAt",
      "ackError",
      "markedReminder",
    ]);
  });

  it("does NOT include ackError when the ack succeeds", async () => {
    setApiForTesting(
      stubApi({
        inboxPull: async () => ({
          messages: [{ seq: "#2", channel: "/s#0042/general", sender: "@x", content: { text: "yo" }, time: "" }],
          hasMore: false,
          markedCount: 0,
        }),
        ack: async (req) => ({ ok: true, applied: req.cursors, failed: [] }),
      }),
    );
    await main(["inbox", "pull"]);
    const env = parseEnvelope(cap.lines()) as {
      success: { acked: number; ackError?: string };
    };
    expect(env.success.acked).toBe(1);
    expect(env.success.ackError).toBeUndefined();
  });

  it("reports only applied cursors as acked and preserves partial failures", async () => {
    setApiForTesting(
      stubApi({
        inboxPull: async () => ({
          messages: [
            { seq: "#2", channel: "/s#0042/general", sender: "@x", content: { text: "ok" }, time: "" },
            { seq: "#4", channel: "/s#0042/private", sender: "@x", content: { text: "blocked" }, time: "" },
          ],
          hasMore: false,
          markedCount: 0,
        }),
        ack: async () => ({
          ok: false,
          applied: [{ channel: "/s#0042/general", seq: 2 }],
          failed: [{
            channel: "/s#0042/private",
            seq: 4,
            code: "forbidden",
            error: "forbidden",
          }],
        }),
      }),
    );

    await main(["inbox", "pull"]);
    const env = parseEnvelope(cap.lines()) as {
      success: { acked: number; failed: Array<{ channel: string; seq: number; code: string; error: string }> };
    };
    expect(env.success.acked).toBe(1);
    expect(env.success.failed).toEqual([{
      channel: "/s#0042/private",
      seq: 4,
      code: "forbidden",
      error: "forbidden",
    }]);
  });

  it.each([
    [0, undefined],
    [1, "You have 1 marked message. Resolve it before going dark unless blocked."],
    [3, "You have 3 marked messages. Resolve them before going dark unless blocked."],
  ])("projects markedCount=%i without fabricating a message", async (markedCount, expected) => {
    setApiForTesting(stubApi({
      inboxPull: async () => ({ messages: [], hasMore: false, markedCount }),
    }));
    await main(["inbox", "pull"]);
    const env = parseEnvelope(cap.lines()) as {
      success: { messages: unknown[]; markedReminder?: string };
    };
    expect(env.success.messages).toEqual([]);
    expect(env.success.markedReminder).toBe(expected);
  });
});

describe("message send — idempotent retry (mutation-idempotency ②)", () => {
  const okRes = {
    state: "sent" as const,
    message: { seq: "#8", channel: "/s#0042/general", sender: "@a", content: { text: "hi" }, time: "" },
  };

  it("attaches a nonce to the send request", async () => {
    const sendSpy = vi.fn(async () => okRes);
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"]);
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
      if (calls === 1) throw new Error("upstream returned 502 with non-JSON body during send");
      return okRes;
    });
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"]);
    const env = parseEnvelope(cap.lines());
    expect(env.success.sent).toBe("/s#0042/general#8"); // succeeded, not an error
    expect(calls).toBe(2); // retried once
    expect(nonces[0]).toBe(nonces[1]); // SAME nonce across the retry — server can dedupe
  });

  it("treats a `deduped` success (same-nonce retry matched the committed message) as sent, not an error", async () => {
    const sendSpy = vi.fn(async () => ({ ...okRes, deduped: true }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"]);
    const env = parseEnvelope(cap.lines());
    expect(env.success.sent).toBe("/s#0042/general#8");
    expect(env.error).toBeUndefined();
  });

  it("does NOT retry a blocked/unaligned business outcome (it's a return, not transient)", async () => {
    const sendSpy = vi.fn(async () => ({ state: "blocked" as const, reason: "unaligned" as const, unreadCount: 2, latestSeq: 9 }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("channel not aligned");
    expect(sendSpy).toHaveBeenCalledTimes(1); // no retry on a business outcome
  });

  it("does NOT retry a non-transient thrown error (e.g. 4xx), surfaces it once", async () => {
    const sendSpy = vi.fn(async () => { throw new Error("reply target #5 not found in /s#0042/general"); });
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("reply target");
    expect(sendSpy).toHaveBeenCalledTimes(1); // deterministic business error — not retried
  });
});

describe("server list", () => {
  it("prints {success:{servers:[...]}} from a stubbed listServers", async () => {
    setApiForTesting(
      stubApi({ listServers: async () => ({ servers: [{ handle: "Design Studio#0042" }] }) }),
    );
    await main(["server", "list"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { servers: [{ handle: "Design Studio#0042" }] } });
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
    await main(["server", "member", "--server", "Design Studio#0042", "--limit", "abc"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "server member: --limit must be a positive integer" });
    expect(listMembersSpy).not.toHaveBeenCalled();
  });

  it("missing --server → error, listMembers never called", async () => {
    const listMembersSpy = vi.fn(async () => ({ members: [], hasMore: false }));
    setApiForTesting(stubApi({ listMembers: listMembersSpy }));
    await main(["server", "member"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "server member: --server <name#discriminator> is required" });
    expect(listMembersSpy).not.toHaveBeenCalled();
  });

  it("surfaces an invalid-handle error verbatim as {error: <message>}", async () => {
    const message = "invalid server handle, expected name#0042";
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
    const joinServerSpy = vi.fn(async () => ({ server: { handle: "Design Studio#0042" } }));
    setApiForTesting(stubApi({ joinServer: joinServerSpy }));
    await main(["server", "join", "--invite", "https://alook.dev/c/invite/AbC123XyZ0"]);
    expect(joinServerSpy).toHaveBeenCalledWith(expect.objectContaining({ invite: "AbC123XyZ0" }));
  });

  it("passes a bare token through unchanged", async () => {
    const joinServerSpy = vi.fn(async () => ({ server: { handle: "Design Studio#0042" } }));
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
    const joinServerSpy = vi.fn(async () => ({ server: { handle: "Design Studio#0042" } }));
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

  it("success prints {success:{server:{handle}}} (no `joined` key)", async () => {
    setApiForTesting(
      stubApi({ joinServer: async () => ({ server: { handle: "Design Studio#0042" } }) }),
    );
    await main(["server", "join", "--invite", "AbC123XyZ0"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { server: { handle: "Design Studio#0042" } } });
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
            { ref: "/demo-workspace#1234/announcements", name: "announcements", type: "text" as const, visibility: "public" as const },
          ],
        },
        {
          category: { name: "Ops", private: false },
          channels: [
            { ref: "/demo-workspace#1234/general", name: "general", type: "text" as const, visibility: "public" as const },
            { ref: "/demo-workspace#1234/help", name: "help", type: "forum" as const, visibility: "public" as const },
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
              { ref: "/demo-workspace#1234/announcements", name: "announcements", type: "text", visibility: "public" },
            ],
          },
          {
            category: { name: "Ops", private: false },
            channels: [
              { ref: "/demo-workspace#1234/general", name: "general", type: "text", visibility: "public" },
              { ref: "/demo-workspace#1234/help", name: "help", type: "forum", visibility: "public" },
            ],
          },
        ],
      },
    });
    expect(listChannelsSpy).toHaveBeenCalledWith(expect.objectContaining({ server: "srv_8fk2" }));
  });

  it("--server accepts a handle and passes it straight through unmodified", async () => {
    const listChannelsSpy = vi.fn(async () => ({ groups: [] }));
    setApiForTesting(stubApi({ listChannels: listChannelsSpy }));
    await main(["channel", "list", "--server", "Design Studio#0042"]);
    expect(listChannelsSpy).toHaveBeenCalledWith(expect.objectContaining({ server: "Design Studio#0042" }));
  });

  it("surfaces an invalid-handle error verbatim as {error: <message>}", async () => {
    const message = "invalid server handle, expected name#0042";
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
    expect(env).toEqual({ error: "channel list: --server <name#discriminator> is required" });
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
    await main(["channel", "member", "--channel", "/demo#0042/general"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({
      success: {
        visibility: "public",
        hint: "This channel is public. Use `alook server member --server demo` to list who can see it.",
      },
    });
    expect(channelMemberSpy).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "/demo#0042/general" }),
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
    await main(["channel", "member", "--channel", "/demo#0042/leadership"]);
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
    await main(["channel", "member", "--channel", "/demo#0042/general/#12"]);
    expect(channelMemberSpy).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "/demo#0042/general/#12" }),
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
      "channel", "history", "--channel", "/demo-workspace#1234/general",
      "--before", "42", "--after", "1", "--around", "20", "--limit", "5",
    ]);
    expect(readSpy).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "/demo-workspace#1234/general", before: 42, after: 1, around: 20, limit: 5 }),
    );
  });

  it("response shape is {items,hasMore,latestSeq?} — omits latestSeq when absent", async () => {
    setApiForTesting(
      stubApi({
        read: async () => ({
          items: [{ seq: "#37", channel: "/s#0042/general", sender: "@a", content: { text: "hi" }, time: "" }],
          hasMore: true,
        }),
      }),
    );
    await main(["channel", "history", "--channel", "/s#0042/general"]);
    const env = parseEnvelope(cap.lines()) as { success: { items: unknown[]; hasMore: boolean } };
    expect(env.success.hasMore).toBe(true);
    expect(env.success.items).toHaveLength(1);
    expect("latestSeq" in env.success).toBe(false);
  });

  it("includes latestSeq when the API returns one", async () => {
    setApiForTesting(stubApi({ read: async () => ({ items: [], hasMore: false, latestSeq: 41 }) }));
    await main(["channel", "history", "--channel", "/s#0042/general"]);
    const env = parseEnvelope(cap.lines()) as { success: { latestSeq: number } };
    expect(env.success.latestSeq).toBe(41);
  });

  it("works for a thread ref — passes it through to api.read() unmodified", async () => {
    const readSpy = vi.fn(async () => ({ items: [], hasMore: false }));
    setApiForTesting(stubApi({ read: readSpy }));
    await main(["channel", "history", "--channel", "/demo-workspace#1234/general/#12"]);
    expect(readSpy).toHaveBeenCalledWith(expect.objectContaining({ channel: "/demo-workspace#1234/general/#12" }));
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
    await main(["message", "emoji", "--target", "/demo#0042/general#42", "--emoji", "👍"]);
    expect(reactAddSpy).toHaveBeenCalledWith({ channel: "/demo#0042/general", seq: 42, emoji: "👍" });
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { target: "/demo#0042/general#42", emoji: "👍", duplicate: false } });
  });

  it("DM ref — calls reactAdd with the DM channel + seq split out", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/.dm/peer#0001#7", "--emoji", "🙏"]);
    expect(reactAddSpy).toHaveBeenCalledWith({ channel: "/.dm/peer#0001", seq: 7, emoji: "🙏" });
  });

  it("the old forum-post ref shape no longer parses (no-compat, phase2 forum≡thread) — errors before reactAdd", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo#0042/ideas/my-post#4", "--emoji", "👍"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toBeDefined();
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
    await main(["message", "emoji", "--target", "/demo#0042/general#42", "--emoji", "👍"]);
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ error: "not a member of #general", hint: "join the channel first" });
  });

  it("thread scope ref without message seq → error, reactAdd never called", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo#0042/general/#5", "--emoji", "👍"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toMatch(/needs a ref with a seq/);
    expect(env.hint).toMatch(/#N#M/);
    expect(reactAddSpy).not.toHaveBeenCalled();
  });

  it("bare channel ref (no #N) → error envelope with seq hint, reactAdd never called", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo#0042/general", "--emoji", "👍"]);
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
    await main(["message", "emoji", "--target", "/demo#0042/general#42"]);
    const env = parseEnvelope(cap.lines());
    expect("error" in env).toBe(true);
    expect(reactAddSpy).not.toHaveBeenCalled();
  });

  it("oversize emoji → error envelope, reactAdd never called", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    const big = "🎉".repeat(20);
    await main(["message", "emoji", "--target", "/demo#0042/general#42", "--emoji", big]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toMatch(/too long/);
    expect(env.hint).toMatch(/single emoji/);
    expect(reactAddSpy).not.toHaveBeenCalled();
  });

  it("duplicate — envelope surfaces duplicate:true, exit code still 0", async () => {
    setApiForTesting(stubApi({ reactAdd: async () => ({ ok: true as const, duplicate: true }) }));
    const code = await main(["message", "emoji", "--target", "/demo#0042/general#42", "--emoji", "👍"]);
    expect(code).toBe(0);
    const env = parseEnvelope(cap.lines()) as { success: { duplicate: boolean } };
    expect(env.success.duplicate).toBe(true);
  });

  it("thread-reply ref — calls reactAdd with thread-scope channel + seq split out", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo#0042/general/#5#42", "--emoji", "👍"]);
    expect(reactAddSpy).toHaveBeenCalledWith({ channel: "/demo#0042/general/#5", seq: 42, emoji: "👍" });
    const env = parseEnvelope(cap.lines());
    expect(env).toEqual({ success: { target: "/demo#0042/general/#5#42", emoji: "👍", duplicate: false } });
  });

  it("thread ROOT via parent channel ref (regression) unchanged", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    await main(["message", "emoji", "--target", "/demo#0042/general#5", "--emoji", "👀"]);
    expect(reactAddSpy).toHaveBeenCalledWith({ channel: "/demo#0042/general", seq: 5, emoji: "👀" });
  });

  it("thread-reply oversize emoji still hits the local check before the wire", async () => {
    const reactAddSpy = vi.fn(async () => ({ ok: true as const, duplicate: false }));
    setApiForTesting(stubApi({ reactAdd: reactAddSpy }));
    const big = "🎉".repeat(20);
    await main(["message", "emoji", "--target", "/demo#0042/general/#5#42", "--emoji", big]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toMatch(/too long/);
    expect(reactAddSpy).not.toHaveBeenCalled();
  });

  it("thread-reply duplicate — envelope surfaces duplicate:true", async () => {
    setApiForTesting(stubApi({ reactAdd: async () => ({ ok: true as const, duplicate: true }) }));
    await main(["message", "emoji", "--target", "/demo#0042/general/#5#42", "--emoji", "👍"]);
    const env = parseEnvelope(cap.lines()) as { success: { duplicate: boolean } };
    expect(env.success.duplicate).toBe(true);
  });
});

describe("message mark", () => {
  it.each([
    ["/demo#0042/general#42", "/demo#0042/general", 42],
    ["/demo#0042/general/#5#7", "/demo#0042/general/#5", 7],
    ["/.dm/peer#0001#9", "/.dm/peer#0001", 9],
  ])("set parses %s and returns the confirmed envelope", async (target, channel, seq) => {
    const markSet = vi.fn(async () => undefined);
    setApiForTesting(stubApi({ markSet }));
    await main(["message", "mark", "set", "--target", target]);
    expect(markSet).toHaveBeenCalledWith({ channel, seq });
    expect(parseEnvelope(cap.lines())).toEqual({ success: { target, marked: true } });
  });

  it("remove forwards the same canonical target and returns marked:false", async () => {
    const markRemove = vi.fn(async () => undefined);
    setApiForTesting(stubApi({ markRemove }));
    await main(["message", "mark", "remove", "--target", "/demo#0042/general#42"]);
    expect(markRemove).toHaveBeenCalledWith({ channel: "/demo#0042/general", seq: 42 });
    expect(parseEnvelope(cap.lines())).toEqual({
      success: { target: "/demo#0042/general#42", marked: false },
    });
  });

  it.each([
    ["set", "markSet", true],
    ["remove", "markRemove", false],
  ] as const)("%s retries one empty upstream 500 into one success envelope", async (command, method, marked) => {
    const mutation = vi.fn()
      .mockRejectedValueOnce(new Error(`upstream returned 500 with non-JSON body during ${method}`))
      .mockResolvedValueOnce(undefined);
    setApiForTesting(stubApi(method === "markSet" ? { markSet: mutation } : { markRemove: mutation }));
    await main(["message", "mark", command, "--target", "/demo#0042/general#42"]);
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(parseEnvelope(cap.lines())).toEqual({
      success: { target: "/demo#0042/general#42", marked },
    });
  });

  it.each([
    ["set", "markSet"],
    ["remove", "markRemove"],
  ] as const)("%s does not retry a 400 business error", async (command, method) => {
    const mutation = vi.fn(async () => {
      throw new Error(`upstream returned 400 with non-JSON body during ${method}`);
    });
    setApiForTesting(stubApi(method === "markSet" ? { markSet: mutation } : { markRemove: mutation }));
    await main(["message", "mark", command, "--target", "/demo#0042/general#42"]);
    expect(mutation).toHaveBeenCalledOnce();
    expect(parseEnvelope(cap.lines()).error).toContain("upstream returned 400");
  });

  it.each([
    ["set", "markSet"],
    ["remove", "markRemove"],
  ] as const)("%s throws after the existing four-attempt 5xx cap", async (command, method) => {
    const mutation = vi.fn(async () => {
      throw new Error(`upstream returned 503 with non-JSON body during ${method}`);
    });
    setApiForTesting(stubApi(method === "markSet" ? { markSet: mutation } : { markRemove: mutation }));
    await main(["message", "mark", command, "--target", "/demo#0042/general#42"]);
    expect(mutation).toHaveBeenCalledTimes(4);
    expect(parseEnvelope(cap.lines()).error).toContain("upstream returned 503");
  });

  it("rejects a target without a message seq locally", async () => {
    const markSet = vi.fn(async () => undefined);
    setApiForTesting(stubApi({ markSet }));
    await main(["message", "mark", "set", "--target", "/demo#0042/general"]);
    expect(parseEnvelope(cap.lines()).error).toContain("needs a ref with a seq");
    expect(markSet).not.toHaveBeenCalled();
  });

  it("list returns all messages through the same local-time projection as inbox", async () => {
    setApiForTesting(stubApi({
      listMarks: async () => ({
        marked: [{
          seq: "#42",
          channel: "/demo#0042/general",
          sender: "@alice#0001",
          content: { text: "task" },
          time: "2026-08-13T04:00:00.000Z",
        }],
      }),
    }));
    await main(["message", "mark", "list"]);
    const env = parseEnvelope(cap.lines()) as { success: { marked: Array<{ time: string }> } };
    expect(env.success.marked).toHaveLength(1);
    expect(env.success.marked[0].time).toMatch(/[+-]\d{2}:\d{2}$/);
  });
});

describe("message attachment upload", () => {
  it("generates a bounded JPEG thumbnail and sends original dimensions", async () => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const { default: sharp } = await import("sharp")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-thumbnail-upload-"))
    const file = path.join(dir, "source.png")
    fs.writeFileSync(file, await sharp({
      create: { width: 640, height: 480, channels: 3, background: "#336699" },
    }).png().toBuffer())
    const uploadSpy = vi.fn(async (req: Parameters<ServerApi["attachmentUpload"]>[0]) => ({
      id: "att_image",
      filename: req.file.filename,
      contentType: req.file.contentType ?? "application/octet-stream",
      size: req.file.data instanceof Uint8Array ? req.file.data.byteLength : req.file.data.size,
      hasThumbnail: req.thumbnail !== undefined,
    }))
    setApiForTesting(stubApi({ attachmentUpload: uploadSpy }))
    try {
      await main(["message", "attachment", "upload", "--target", "/demo#0042/general", "--file", file])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    const request = uploadSpy.mock.calls[0]![0]
    expect(request).toMatchObject({ width: 640, height: 480 })
    expect(request.thumbnail?.contentType).toBe("image/jpeg")
    expect(request.thumbnail?.data).toBeInstanceOf(Uint8Array)
    const bytes = request.thumbnail!.data as Uint8Array
    expect(bytes.byteLength).toBeLessThanOrEqual(50 * 1024)
    expect([...bytes.slice(0, 2)]).toEqual([0xff, 0xd8])
    expect([...bytes.slice(-2)]).toEqual([0xff, 0xd9])
    expect(parseEnvelope(cap.lines())).toMatchObject({ success: { hasThumbnail: true } })
  })

  it.each(["jpg", "webp", "gif"])("generates a thumbnail for valid .%s raster input", async (extension) => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const { default: sharp } = await import("sharp")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-raster-matrix-"))
    const file = path.join(dir, `source.${extension}`)
    let pipeline = sharp({ create: { width: 32, height: 24, channels: 3, background: "#123456" } })
    pipeline = extension === "jpg" ? pipeline.jpeg() : extension === "webp" ? pipeline.webp() : pipeline.gif()
    fs.writeFileSync(file, await pipeline.toBuffer())
    const uploadSpy = vi.fn(async () => ({
      id: "att", filename: `source.${extension}`, contentType: "image/test", size: 1, hasThumbnail: true,
    }))
    setApiForTesting(stubApi({ attachmentUpload: uploadSpy }))
    try {
      await main(["message", "attachment", "upload", "--target", "/demo#0042/general", "--file", file])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(uploadSpy.mock.calls[0]![0]).toMatchObject({ width: 32, height: 24 })
    expect(uploadSpy.mock.calls[0]![0].thumbnail?.contentType).toBe("image/jpeg")
  })

  it("uploads corrupt declared raster input without thumbnail or dimensions", async () => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-corrupt-image-"))
    const file = path.join(dir, "corrupt.png")
    fs.writeFileSync(file, "not an image")
    const uploadSpy = vi.fn(async () => ({
      id: "att", filename: "corrupt.png", contentType: "image/png", size: 12, hasThumbnail: false,
    }))
    setApiForTesting(stubApi({ attachmentUpload: uploadSpy }))
    try {
      await main(["message", "attachment", "upload", "--target", "/demo#0042/general", "--file", file])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    const request = uploadSpy.mock.calls[0]![0]
    expect(request.thumbnail).toBeUndefined()
    expect(request.width).toBeUndefined()
    expect(request.height).toBeUndefined()
    expect(parseEnvelope(cap.lines())).toMatchObject({ success: { hasThumbnail: false } })
  })

  it.each([
    { extension: "html", contentType: "text/html" },
    { extension: "htm", contentType: "text/html" },
    { extension: "blend", contentType: "application/octet-stream" },
  ])("uploads .$extension files as $contentType", async ({ extension, contentType }) => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-attachment-upload-"));
    const file = path.join(dir, `prototype.${extension}`);
    const body = "<!doctype html><title>Motion prototype</title>";
    fs.writeFileSync(file, body);

    const uploadSpy = vi.fn(async (req: Parameters<ServerApi["attachmentUpload"]>[0]) => ({
      id: "att_file",
      filename: req.file.filename,
      contentType: req.file.contentType ?? "application/octet-stream",
      size: req.file.data instanceof Uint8Array ? req.file.data.byteLength : req.file.data.size,
    }));
    setApiForTesting(stubApi({ attachmentUpload: uploadSpy }));

    try {
      await main([
        "message",
        "attachment",
        "upload",
        "--target",
        "/demo#0042/general",
        "--file",
        file,
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy).toHaveBeenCalledWith({
      agentId: "agent_test",
      target: "/demo#0042/general",
      file: {
        data: new Uint8Array(Buffer.from(body)),
        filename: `prototype.${extension}`,
        contentType,
      },
    });
    expect(parseEnvelope(cap.lines())).toEqual({
      success: {
        id: "att_file",
        filename: `prototype.${extension}`,
        contentType,
        size: Buffer.byteLength(body),
      },
    });
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

describe("setting profile", () => {
  it("rejects an empty command before calling ServerApi", async () => {
    const updateProfile = vi.fn();
    setApiForTesting(stubApi({ updateProfile }));
    await main(["setting", "profile"]);
    const env = parseEnvelope(cap.lines());
    expect(env.error).toContain("--set-bio")
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("accepts an empty bio as an explicit clear", async () => {
    const updateProfile = vi.fn(async () => ({ updated: ["bio" as const], bio: "" }));
    setApiForTesting(stubApi({ updateProfile }));
    await main(["setting", "profile", "--set-bio", ""]);
    expect(parseEnvelope(cap.lines())).toEqual({ success: { updated: ["bio"], bio: "" } });
    expect(updateProfile).toHaveBeenCalledWith({ bio: "" });
  });

  it("updates a non-empty bio without an avatar", async () => {
    const updateProfile = vi.fn(async () => ({ updated: ["bio" as const], bio: "Backend and infrastructure" }));
    setApiForTesting(stubApi({ updateProfile }));
    await main(["setting", "profile", "--set-bio", "Backend and infrastructure"]);
    expect(parseEnvelope(cap.lines())).toEqual({
      success: { updated: ["bio"], bio: "Backend and infrastructure" },
    });
    expect(updateProfile).toHaveBeenCalledWith({ bio: "Backend and infrastructure" });
  });

  it("updates an avatar without a bio", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
    const file = path.join(dir, "avatar.webp");
    fs.writeFileSync(file, new Uint8Array([1, 2, 3]));
    const updateProfile = vi.fn(async () => ({
      updated: ["avatar" as const],
      avatarUrl: "/api/community/bots/agent_test/avatar",
    }));
    setApiForTesting(stubApi({ updateProfile }));
    await main(["setting", "profile", "--set-avatar", file]);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(parseEnvelope(cap.lines())).toEqual({
      success: {
        updated: ["avatar"],
        avatarUrl: "/api/community/bots/agent_test/avatar",
      },
    });
    expect(updateProfile).toHaveBeenCalledWith({
      avatar: expect.objectContaining({ filename: "avatar.webp", contentType: "image/webp" }),
    });
  });

  it("preflights and sends bio plus avatar in one logical request", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
    const file = path.join(dir, "avatar.png");
    fs.writeFileSync(file, new Uint8Array([1, 2, 3]));
    const updateProfile = vi.fn(async () => ({
      updated: ["avatar" as const, "bio" as const],
      avatarUrl: "/api/community/bots/agent_test/avatar",
      bio: "infra",
    }));
    setApiForTesting(stubApi({ updateProfile }));
    await main(["setting", "profile", "--set-bio", "infra", "--set-avatar", file]);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(parseEnvelope(cap.lines())).toEqual({
      success: {
        updated: ["avatar", "bio"],
        avatarUrl: "/api/community/bots/agent_test/avatar",
        bio: "infra",
      },
    });
    expect(updateProfile).toHaveBeenCalledWith({
      bio: "infra",
      avatar: expect.objectContaining({ filename: "avatar.png", contentType: "image/png" }),
    });
  });

  it("rejects an unsupported avatar before calling ServerApi", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
    const file = path.join(dir, "avatar.svg");
    fs.writeFileSync(file, "<svg/>");
    const updateProfile = vi.fn();
    setApiForTesting(stubApi({ updateProfile }));
    await main(["setting", "profile", "--set-avatar", file]);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(parseEnvelope(cap.lines()).error).toContain("png / jpeg / webp / gif");
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("rejects a missing avatar before calling ServerApi", async () => {
    const os = await import("os");
    const path = await import("path");
    const updateProfile = vi.fn();
    setApiForTesting(stubApi({ updateProfile }));
    const missing = path.join(os.tmpdir(), `missing-avatar-${Date.now()}.png`);
    await main(["setting", "profile", "--set-avatar", missing]);
    expect(parseEnvelope(cap.lines()).error).toContain("cannot read avatar");
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("rejects an oversize avatar before calling ServerApi", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
    const file = path.join(dir, "avatar.png");
    fs.writeFileSync(file, new Uint8Array(MAX_SERVER_ICON_SIZE_BYTES + 1));
    const updateProfile = vi.fn();
    setApiForTesting(stubApi({ updateProfile }));
    await main(["setting", "profile", "--set-avatar", file]);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(parseEnvelope(cap.lines()).error).toContain("avatar too large");
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("rejects an empty avatar before calling ServerApi", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
    const file = path.join(dir, "avatar.png");
    fs.writeFileSync(file, "");
    const updateProfile = vi.fn();
    setApiForTesting(stubApi({ updateProfile }));
    await main(["setting", "profile", "--set-avatar", file]);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(parseEnvelope(cap.lines()).error).toContain("empty");
    expect(updateProfile).not.toHaveBeenCalled();
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

describe("message send — literal stdin/file body contract", () => {
  it("forwards stdin byte-for-byte without shell expansion or escape decoding", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const marker = path.join(os.tmpdir(), `alook-stdin-marker-${Date.now()}-${Math.random()}`);
    let sentText: string | undefined;
    setApiForTesting(
      stubApi({
        send: async (input: Parameters<ServerApi["send"]>[0]) => {
          sentText = input.content.text;
          return { state: "sent", message: { seq: "#1", channel: "/s/c", sender: "@a", content: { text: "" }, time: "" } };
        },
      }),
    );
    const literal = `  \`marker\` $(touch ${marker}) \${HOME} ' \\\" \\\\ a\\\\nb\n# markdown\n总部 🎉  \n`;
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"], literal);
    expect(sentText).toBe(literal);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("decodes UTF-8 once after joining split stdin byte chunks", async () => {
    const literal = "中文 🎉";
    const bytes = Buffer.from(literal, "utf8");
    const input = Readable.from([bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)]) as CliInputStream;
    let sentText: string | undefined;
    setApiForTesting(stubApi({
      send: async (request: Parameters<ServerApi["send"]>[0]) => {
        sentText = request.content.text;
        return { state: "sent", message: { seq: "#1", channel: "/s/c", sender: "@a", content: { text: "" }, time: "" } };
      },
    }));
    await main(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"], { stdin: input });
    expect(sentText).toBe(literal);
  });

  it("forwards file content byte-for-byte, including surrounding whitespace", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-esc-"));
    const file = path.join(dir, "body.txt");
    const literal = "  a\\\\nb\n总部 🎉  \n";
    fs.writeFileSync(file, literal);
    let sentText: string | undefined;
    setApiForTesting(
      stubApi({
        send: async (input: Parameters<ServerApi["send"]>[0]) => {
          sentText = input.content.text;
          return { state: "sent", message: { seq: "#1", channel: "/s/c", sender: "@a", content: { text: "" }, time: "" } };
        },
      }),
    );
    await main(["message", "send", "--target", "/s#0042/general", "--file", file, "--remind-after", "0"]);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(sentText).toBe(literal);
  });

  it("rejects --stdin with --file before sending", async () => {
    const sendSpy = vi.fn();
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0", "--file", "body.md"]);
    expect(parseEnvelope(cap.lines()).error).toContain("mutually exclusive");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("fails fast when --stdin is attached to a TTY", async () => {
    const sendSpy = vi.fn();
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"], "", true);
    expect(parseEnvelope(cap.lines()).error).toContain("requires piped input");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("allows whitespace-only stdin only when an attachment is present", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#1", channel: "/s/c", sender: "@a", content: { text: "" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"], "   \n");
    expect(parseEnvelope(cap.lines()).error).toContain("--stdin");
    expect(sendSpy).not.toHaveBeenCalled();

    cap.lines().length = 0;
    await mainWithStdin(
      ["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0", "--attachment", "att_1"],
      "   \n",
    );
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ content: { text: "   \n" } }));
  });

  it("keeps attachment-only sends valid without reading stdin", async () => {
    const sendSpy = vi.fn(async () => ({
      state: "sent" as const,
      message: { seq: "#1", channel: "/s/c", sender: "@a", content: { text: "" }, time: "" },
    }));
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s#0042/general", "--attachment", "att_1", "--remind-after", "0"]);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      content: { text: "" },
      attachments: ["att_1"],
    }));
  });

  it("rejects empty EOF and an unreadable body file before sending", async () => {
    const os = await import("os");
    const path = await import("path");
    const sendSpy = vi.fn();
    setApiForTesting(stubApi({ send: sendSpy }));
    await mainWithStdin(["message", "send", "--target", "/s#0042/general", "--stdin", "--remind-after", "0"], "");
    expect(parseEnvelope(cap.lines()).error).toContain("--stdin");

    cap.lines().length = 0;
    const missing = path.join(os.tmpdir(), `alook-missing-${Date.now()}-${Math.random()}.md`);
    await main(["message", "send", "--target", "/s#0042/general", "--file", missing, "--remind-after", "0"]);
    expect(parseEnvelope(cap.lines()).error).toContain("cannot read file");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("documents --stdin and removes --text from send help", async () => {
    await main(["message", "send", "-h"]);
    const help = cap.lines().join("");
    expect(help).toContain("--stdin");
    expect(help).not.toContain("--text");
  });

  it("removes --text from the public parser", async () => {
    const sendSpy = vi.fn();
    setApiForTesting(stubApi({ send: sendSpy }));
    await main(["message", "send", "--target", "/s#0042/general", "--text", "legacy", "--remind-after", "0"]);
    expect(parseEnvelope(cap.lines()).error).toContain("unknown option '--text'");
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("nap", () => {
  it("errors when --handoff is missing, and never calls api.nap", async () => {
    const napSpy = vi.fn(async () => ({ napped: true }));
    setApiForTesting(stubApi({ nap: napSpy }));
    await main(["nap"]);
    const env = parseEnvelope(cap.lines());
    expect(typeof env.error).toBe("string");
    expect(napSpy).not.toHaveBeenCalled();
  });

  it("errors on a whitespace-only handoff file", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nap-empty-"));
    const file = path.join(dir, "handoff.md");
    fs.writeFileSync(file, "   \n");
    const napSpy = vi.fn(async () => ({ napped: true }));
    setApiForTesting(stubApi({ nap: napSpy }));
    await main(["nap", "--handoff", file]);
    fs.rmSync(dir, { recursive: true, force: true });
    const env = parseEnvelope(cap.lines());
    expect(typeof env.error).toBe("string");
    expect(napSpy).not.toHaveBeenCalled();
  });

  it("reads the handoff from --handoff <file> without trimming", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nap-"));
    const file = path.join(dir, "handoff.md");
    const literal = "  Was mid-review of PR #42; next: run QA.\\\\n\n中文 🎉  \n";
    fs.writeFileSync(file, literal);
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
    expect(handoff).toBe(literal);
  });

  it("rejects --stdin and an unreadable handoff file", async () => {
    const os = await import("os");
    const path = await import("path");
    const napSpy = vi.fn();
    setApiForTesting(stubApi({ nap: napSpy }));
    await main(["nap", "--stdin"]);
    expect(parseEnvelope(cap.lines()).error).toContain("unknown option '--stdin'");
    expect(napSpy).not.toHaveBeenCalled();

    cap.lines().length = 0;
    const missing = path.join(os.tmpdir(), `alook-missing-handoff-${Date.now()}-${Math.random()}.md`);
    await main(["nap", "--handoff", missing]);
    expect(parseEnvelope(cap.lines()).error).toContain("cannot read file");
    expect(napSpy).not.toHaveBeenCalled();
  });

  it("removes --text from the public parser", async () => {
    const napSpy = vi.fn();
    setApiForTesting(stubApi({ nap: napSpy }));
    await main(["nap", "--text", "legacy"]);
    expect(parseEnvelope(cap.lines()).error).toContain("unknown option '--text'");
    expect(napSpy).not.toHaveBeenCalled();
  });

  it("documents only --handoff and removes --stdin/--text from nap help", async () => {
    await main(["nap", "-h"]);
    const help = cap.lines().join("");
    expect(help).toContain("--handoff <file>");
    expect(help).not.toContain("--stdin");
    expect(help).not.toContain("--text");
  });
});
