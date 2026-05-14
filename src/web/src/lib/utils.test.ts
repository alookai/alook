import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let mockHostname: string | undefined;

vi.mock("./utils", async () => {
  const actual = await vi.importActual<typeof import("./utils")>("./utils");
  return {
    ...actual,
    isLocalMode: () => {
      if (mockHostname && ["localhost", "127.0.0.1"].includes(mockHostname)) return true;
      return process.env.NODE_ENV === "development";
    },
    cliCmd: () => {
      if (process.env.NODE_ENV === "development") return "pnpm dev:cli";
      if (mockHostname && ["localhost", "127.0.0.1"].includes(mockHostname)) {
        return "npx @alook/app cli";
      }
      return "npx @alook/cli";
    },
    daemonStartCmd: () => {
      let base: string;
      if (process.env.NODE_ENV === "development") base = "pnpm dev:cli";
      else if (mockHostname && ["localhost", "127.0.0.1"].includes(mockHostname)) base = "npx @alook/app cli";
      else base = "npx @alook/cli";
      const cmd = `${base} daemon start`;
      if (process.env.NODE_ENV === "development") return `${cmd} --foreground`;
      return cmd;
    },
  };
});

import { isLocalMode, cliCmd, daemonStartCmd } from "./utils";

beforeEach(() => {
  mockHostname = undefined;
});

afterEach(() => {
  mockHostname = undefined;
});

describe("isLocalMode", () => {
  it("returns true on localhost", () => {
    mockHostname = "localhost";
    expect(isLocalMode()).toBe(true);
  });

  it("returns true on 127.0.0.1", () => {
    mockHostname = "127.0.0.1";
    expect(isLocalMode()).toBe(true);
  });

  it("returns false for non-local hostname in production build", () => {
    mockHostname = "alook.ai";
    expect(isLocalMode()).toBe(false);
  });
});

describe("cliCmd", () => {
  it("returns 'npx @alook/cli' in production cloud", () => {
    mockHostname = "alook.ai";
    expect(cliCmd()).toBe("npx @alook/cli");
  });

  it("returns 'npx @alook/app cli' on localhost (app mode)", () => {
    mockHostname = "localhost";
    expect(cliCmd()).toBe("npx @alook/app cli");
  });
});

describe("daemonStartCmd", () => {
  it("no --foreground in production cloud", () => {
    mockHostname = "alook.ai";
    expect(daemonStartCmd()).toBe("npx @alook/cli daemon start");
    expect(daemonStartCmd()).not.toContain("--foreground");
  });

  it("no --foreground in app mode (localhost, production build)", () => {
    mockHostname = "localhost";
    expect(daemonStartCmd()).toBe("npx @alook/app cli daemon start");
    expect(daemonStartCmd()).not.toContain("--foreground");
  });
});
