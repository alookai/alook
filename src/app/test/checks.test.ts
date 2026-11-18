import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
}));

vi.mock("net", () => ({
  createConnection: mocks.createConnection,
}));

function connectionThatEmits(eventToEmit: "connect" | "error") {
  const connection = {
    destroy: vi.fn(),
    on: vi.fn(),
  };
  connection.on.mockImplementation((event: string, handler: () => void) => {
    if (event === eventToEmit) handler();
    return connection;
  });
  return connection;
}

describe("checks", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("checkNodeVersion", () => {
    const actualVersion = process.versions.node;
    afterEach(() => {
      Object.defineProperty(process.versions, "node", { value: actualVersion });
      vi.restoreAllMocks();
    });

    it.each(["20.9.0", "21.12.0", "22.11.0"])("rejects unsupported Node %s", async (version) => {
      Object.defineProperty(process.versions, "node", { value: version });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });

      const { checkNodeVersion } = await import("../src/lib/checks.js");
      expect(() => checkNodeVersion()).toThrow("exit");
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(error).toHaveBeenCalledExactlyOnceWith(`Error: Node.js >= 22.12 required (found ${version})`);
    });

    it.each(["22.12.0", "22.12.1", "23.0.0", "24.0.0"])("accepts supported Node %s", async (version) => {
      Object.defineProperty(process.versions, "node", { value: version });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("unexpected exit");
      });
      const { checkNodeVersion } = await import("../src/lib/checks.js");
      expect(() => checkNodeVersion()).not.toThrow();
      expect(exit).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe("checkPort", () => {
    it("returns true for an unused port", async () => {
      mocks.createConnection.mockReturnValue(connectionThatEmits("error"));
      const { checkPort } = await import("../src/lib/checks.js");
      const result = await checkPort(49999);
      expect(result).toBe(true);
    });
  });

  describe("checkPorts", () => {
    it("accepts four deterministically available service ports", async () => {
      mocks.createConnection.mockImplementation(() => connectionThatEmits("error"));
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("unexpected exit");
      }) as never);
      const { checkPorts } = await import("../src/lib/checks.js");

      await expect(checkPorts({
        web: 3000,
        emailWorker: 8787,
        wsDo: 8789,
        queueWorker: 8790,
      })).resolves.toBeUndefined();

      expect(mocks.createConnection.mock.calls.map(([options]) => options)).toEqual([
        { port: 3000, host: "127.0.0.1" },
        { port: 8787, host: "127.0.0.1" },
        { port: 8789, host: "127.0.0.1" },
        { port: 8790, host: "127.0.0.1" },
      ]);
      expect(exit).not.toHaveBeenCalled();
      exit.mockRestore();
    });
  });
});
