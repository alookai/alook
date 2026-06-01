import { describe, it, expect } from "vitest";
import { resolveMode, cliCommand, daemonCommand, getBaseUrl } from "../src/mode";

describe("resolveMode", () => {
  it("production: no signals", () => {
    expect(resolveMode({})).toBe("production");
  });

  it("production: non-development NODE_ENV", () => {
    expect(resolveMode({ nodeEnv: "production" })).toBe("production");
  });

  it("production: random hostname", () => {
    expect(resolveMode({ hostname: "alook.ai" })).toBe("production");
  });

  it("dev: NODE_ENV=development", () => {
    expect(resolveMode({ nodeEnv: "development" })).toBe("dev");
  });

  it("dev: local ALOOK_SERVER_URL without CMD_PREFIX", () => {
    expect(resolveMode({ serverUrl: "http://localhost:3000" })).toBe("dev");
  });

  it("dev: ALOOK_SERVER_URL + NODE_ENV=development", () => {
    expect(
      resolveMode({ serverUrl: "http://localhost:3000", nodeEnv: "development" }),
    ).toBe("dev");
  });

  it("production: ALOOK_SERVER_URL set with NODE_ENV=production", () => {
    expect(
      resolveMode({ serverUrl: "https://alook.ai", nodeEnv: "production" }),
    ).toBe("production");
  });

  it("production: non-local ALOOK_SERVER_URL without NODE_ENV", () => {
    expect(
      resolveMode({ serverUrl: "https://alook.ai" }),
    ).toBe("production");
  });

  it("app: CMD_PREFIX set (overrides serverUrl)", () => {
    expect(
      resolveMode({
        serverUrl: "http://localhost:15210",
        cmdPrefix: "npx @alook/app cli",
      }),
    ).toBe("app");
  });

  it("app: CMD_PREFIX set overrides NODE_ENV=development", () => {
    expect(
      resolveMode({
        nodeEnv: "development",
        cmdPrefix: "npx @alook/app cli",
      }),
    ).toBe("app");
  });

  it("app: localhost hostname", () => {
    expect(resolveMode({ hostname: "localhost" })).toBe("app");
  });

  it("app: 127.0.0.1 hostname", () => {
    expect(resolveMode({ hostname: "127.0.0.1" })).toBe("app");
  });

  it("app: localhost hostname with production NODE_ENV", () => {
    expect(
      resolveMode({ nodeEnv: "production", hostname: "localhost" }),
    ).toBe("app");
  });
});

describe("cliCommand", () => {
  it("production → npx @alook/cli", () => {
    expect(cliCommand("production")).toBe("npx @alook/cli");
  });

  it("dev → pnpm dev:cli", () => {
    expect(cliCommand("dev")).toBe("pnpm dev:cli");
  });

  it("app → npx @alook/app cli", () => {
    expect(cliCommand("app")).toBe("npx @alook/app cli");
  });
});

describe("daemonCommand", () => {
  it("production → no --foreground", () => {
    expect(daemonCommand("production")).toBe("npx @alook/cli daemon start");
  });

  it("dev → with --foreground", () => {
    expect(daemonCommand("dev")).toBe("pnpm dev:cli daemon start --foreground");
  });

  it("app → no --foreground", () => {
    expect(daemonCommand("app")).toBe("npx @alook/app cli daemon start");
  });
});

describe("getBaseUrl", () => {
  it("prefers serverUrl when set", () => {
    expect(getBaseUrl({ serverUrl: "http://localhost:3000", appUrl: "https://app.example.com" })).toBe("http://localhost:3000");
  });

  it("falls back to appUrl when serverUrl not set", () => {
    expect(getBaseUrl({ appUrl: "https://app.example.com" })).toBe("https://app.example.com");
  });

  it("returns localhost in development when no URLs set", () => {
    expect(getBaseUrl({ nodeEnv: "development" })).toBe("http://localhost:3000");
  });

  it("returns production URL when no signals", () => {
    expect(getBaseUrl({})).toBe("https://alook.ai");
  });

  it("returns production URL in production mode with no URLs", () => {
    expect(getBaseUrl({ nodeEnv: "production" })).toBe("https://alook.ai");
  });
});
