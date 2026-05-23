import { describe, it, expect, afterEach } from "vitest";
import { isDev, cmdPrefix } from "./env.js";

afterEach(() => {
  delete process.env.ALOOK_SERVER_URL;
  delete process.env.ALOOK_CMD_PREFIX;
});

describe("isDev", () => {
  it("returns false when ALOOK_SERVER_URL is not set", () => {
    expect(isDev()).toBe(false);
  });

  it("returns true when ALOOK_SERVER_URL is set", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    expect(isDev()).toBe(true);
  });

  it("returns false when ALOOK_CMD_PREFIX is set (app mode)", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    process.env.ALOOK_CMD_PREFIX = "npx @alook/app cli";
    expect(isDev()).toBe(false);
  });
});

describe("cmdPrefix", () => {
  it("returns 'npx @alook/cli' in production", () => {
    expect(cmdPrefix()).toBe("npx @alook/cli");
  });

  it("returns 'pnpm dev:cli' in dev", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    expect(cmdPrefix()).toBe("pnpm dev:cli");
  });

  it("returns ALOOK_CMD_PREFIX when set", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    process.env.ALOOK_CMD_PREFIX = "npx @alook/app cli";
    expect(cmdPrefix()).toBe("npx @alook/app cli");
  });
});
