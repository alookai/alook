import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer } from "net";
import { DEFAULT_SERVICE_PROFILE } from "../src/lib/constants.js";

async function releasedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("checks", () => {
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
      const { checkPort } = await import("../src/lib/checks.js");
      const result = await checkPort(await releasedPort());
      expect(result).toBe(true);
    });

    it("suggests the stop command when an Alook port is occupied", async () => {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing listener address");

      try {
        const { checkPorts } = await import("../src/lib/checks.js");
        const profile = structuredClone(DEFAULT_SERVICE_PROFILE);
        profile.web.business = address.port;
        await expect(checkPorts(profile)).rejects.toThrow(/web business.*npx @alook\/app stop/s);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("fails on an ownerless inspector collision without touching its listener", async () => {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing listener address");
      try {
        const { checkPorts } = await import("../src/lib/checks.js");
        const available = await Promise.all(Array.from({ length: 7 }, () => releasedPort()));
        const profile = {
          web: { business: available[0], inspector: address.port },
          emailWorker: { business: available[1], inspector: available[2] },
          wsDo: { business: available[3], inspector: available[4] },
          wakeWorker: { business: available[5], inspector: available[6] },
        };
        await expect(checkPorts(profile)).rejects.toThrow(/web inspector.*npx @alook\/app stop/s);
        expect(server.listening).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("locks the default name-keyed business and inspector profile", () => {
      expect(DEFAULT_SERVICE_PROFILE).toEqual({
        web: { business: 15210, inspector: 19229 },
        emailWorker: { business: 15211, inspector: 19231 },
        wsDo: { business: 15212, inspector: 19230 },
        wakeWorker: { business: 15213, inspector: 19232 },
      });
    });

    it("rejects duplicate derived and business ports", async () => {
      const { validateServicePortProfile } = await import("../src/lib/checks.js");
      const profile = structuredClone(DEFAULT_SERVICE_PROFILE);
      profile.wsDo.business = profile.web.inspector;
      expect(() => validateServicePortProfile(profile)).toThrow("assigned to both");
    });

    it.each([0, 65_536, 1.5])("rejects invalid port %s", async (port) => {
      const { validateServicePortProfile } = await import("../src/lib/checks.js");
      const profile = structuredClone(DEFAULT_SERVICE_PROFILE);
      profile.web.business = port;
      expect(() => validateServicePortProfile(profile)).toThrow("invalid web.business port");
    });
  });
});
