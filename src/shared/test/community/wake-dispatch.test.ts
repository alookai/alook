import { describe, it, expect, vi } from "vitest";
import { sendWakeToMachine } from "../../src/community/wake-dispatch";
import type { HostCommand } from "../../src/community-cli-contract";

const dummyCommand = {
  type: "agent:wake",
  agentId: "bot-1",
  config: { version: 1, runtime: "claude" },
  launchId: "launch-1",
  unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 1 },
} as unknown as HostCommand;

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return { WS_DO_WORKER: { fetch: vi.fn(fetchImpl) } as unknown as Fetcher };
}

describe("sendWakeToMachine", () => {
  it("POSTs the command verbatim to the ws-do forward-agent-wake route", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://internal/community-machine/by-id/machine-1/forward-agent-wake");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual(dummyCommand);
      return new Response(JSON.stringify({ sent: 1 }), { status: 200 });
    });
    const env = makeEnv(fetchMock);

    const result = await sendWakeToMachine(env, "machine-1", dummyCommand);

    expect(result).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes { sent: 0 } (daemon offline) to { sent: false }", async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ sent: 0 }), { status: 200 }));

    const result = await sendWakeToMachine(env, "machine-1", dummyCommand);

    expect(result).toEqual({ sent: false });
  });

  it("normalizes any positive sent count to { sent: true }", async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ sent: 3 }), { status: 200 }));

    const result = await sendWakeToMachine(env, "machine-1", dummyCommand);

    expect(result).toEqual({ sent: true });
  });

  it("throws on non-2xx response (transient — consumer must retry)", async () => {
    const env = makeEnv(async () => new Response("boom", { status: 500 }));

    await expect(sendWakeToMachine(env, "machine-1", dummyCommand)).rejects.toThrow();
  });

  it("throws when the underlying fetch itself rejects (network error)", async () => {
    const env = makeEnv(async () => {
      throw new Error("network unreachable");
    });

    await expect(sendWakeToMachine(env, "machine-1", dummyCommand)).rejects.toThrow("network unreachable");
  });

  it("encodes the machineId in the URL path", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://internal/community-machine/by-id/machine%2Fwith%2Fslash/forward-agent-wake");
      return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
    });
    const env = makeEnv(fetchMock);

    await sendWakeToMachine(env, "machine/with/slash", dummyCommand);
  });
});
