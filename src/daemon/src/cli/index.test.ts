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
    listChannels: async () => ({ channels: [] }),
    inboxPull: async () => ({ messages: [], hasMore: false }),
    inboxSnapshot: async () => ({ rows: [], pendingChannels: 0, pendingMessages: 0 }),
    ack: async () => undefined,
    send: async () => ({ state: "sent", message: { seq: "#1", channel: "/s/c", sender: "@a", content: { text: "" }, time: "" } }),
    read: async () => ({ items: [], hasMore: false }),
    resolve: async () => null,
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
    const code = await main(["message", "send", "--target", "/s/general", "--text", "hi"]);
    const env = parseEnvelope(cap.lines());
    expect(code).toBe(0);
    expect(env).toEqual({ success: { sent: "/s/general#7" } });
    expect("error" in env).toBe(false);
    expect("hint" in env).toBe(false); // null fields omitted
  });

  it("prints only `error` on failure (success/hint omitted)", async () => {
    setApiForTesting(stubApi());
    // No --text or --file → error
    await main(["message", "send", "--target", "/s/general"]);
    const env = parseEnvelope(cap.lines());
    expect(typeof env.error).toBe("string");
    expect(env.error).toContain("--text");
    expect("success" in env).toBe(false);
    expect("hint" in env).toBe(false);
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
    await main(["message", "send", "--target", "/s/general", "--text", "hi"]);
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
    const env = parseEnvelope(cap.lines()) as { success: { acked: number; messages: unknown[] } };
    expect(ackSpy).toHaveBeenCalledOnce();
    expect(env.success.acked).toBe(1);
    expect(env.success.messages).toHaveLength(1);
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
});
