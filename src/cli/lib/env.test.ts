import { describe, it, expect, afterEach } from "vitest";
import { isDev, cmdPrefix } from "./env.js";

afterEach(() => {
  delete process.env.ALOOK_SERVER_URL;
});

describe("isDev", () => {
  it("returns false when ALOOK_SERVER_URL is not set", () => {
    expect(isDev()).toBe(false);
  });

  it("returns true when ALOOK_SERVER_URL is set", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    expect(isDev()).toBe(true);
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
});
