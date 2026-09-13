import { describe, it, expect, vi, beforeEach } from "vitest";

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
    it("does not exit for Node >= 20", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as never);

      const { checkNodeVersion } = await import("../src/lib/checks.js");
      const major = parseInt(process.versions.node.split(".")[0], 10);
      if (major >= 20) {
        expect(() => checkNodeVersion()).not.toThrow();
      }
      exitSpy.mockRestore();
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
