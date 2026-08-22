import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";

const createServer = vi.hoisted(() => vi.fn());

vi.mock("node:net", () => ({ createServer }));

describe("OpenCode loopback allocation", () => {
  it("fails closed when the listener reports no TCP address", async () => {
    createServer.mockReturnValue(Object.assign(new EventEmitter(), {
      unref: vi.fn(),
      listen: vi.fn((_options, ready: () => void) => ready()),
      address: vi.fn(() => null),
      close: vi.fn((done: () => void) => done()),
    }));
    const { OpenCodeServiceLane } = await import("./service-lane.js");
    const spawnService = vi.fn();
    const lane = new OpenCodeServiceLane(
      { spawnService },
      fakeLaunchContext("opencode", process.cwd()),
      { password: "test-password", portAttempts: 1 },
    );

    await expect(lane.start({ text: "root", terminalOwner: "msg_root" }))
      .rejects.toThrow("returned no TCP address");
    expect(spawnService).not.toHaveBeenCalled();
  });
});
