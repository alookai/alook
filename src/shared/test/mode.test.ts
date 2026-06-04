import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveMode, cliCommand, cliPackageName, updateCommand, daemonCommand, getBaseUrl, isTauri, isDesktop, isMobile, tauriInvoke } from "../src/mode";

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

  it("desktop: tauri signal set", () => {
    expect(resolveMode({ tauri: true })).toBe("desktop");
  });

  it("desktop: tauri signal with tauriPlatform desktop", () => {
    expect(resolveMode({ tauri: true, tauriPlatform: "desktop" })).toBe("desktop");
  });

  it("mobile: tauri signal with tauriPlatform mobile", () => {
    expect(resolveMode({ tauri: true, tauriPlatform: "mobile" })).toBe("mobile");
  });

  it("desktop: tauri overrides other signals", () => {
    expect(
      resolveMode({ tauri: true, nodeEnv: "development", cmdPrefix: "npx @alook/app cli" }),
    ).toBe("desktop");
  });
});

describe("isTauri", () => {
  afterEach(() => {
    // Clean up __TAURI__ from globalThis.window if set
    if ("window" in globalThis) {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  it("returns false when window is not defined", () => {
    expect(isTauri()).toBe(false);
  });

  it("returns false when window exists but __TAURI__ is missing", () => {
    (globalThis as Record<string, unknown>).window = {};
    expect(isTauri()).toBe(false);
  });

  it("returns true when window.__TAURI__ exists", () => {
    (globalThis as Record<string, unknown>).window = { __TAURI__: {} };
    expect(isTauri()).toBe(true);
  });
});

describe("isDesktop", () => {
  afterEach(() => {
    if ("window" in globalThis) {
      delete (globalThis as Record<string, unknown>).window;
    }
    if ("navigator" in globalThis) {
      delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  it("returns false when not in Tauri", () => {
    expect(isDesktop()).toBe(false);
  });

  it("returns true in Tauri with desktop user agent", () => {
    (globalThis as Record<string, unknown>).window = { __TAURI__: {} };
    (globalThis as Record<string, unknown>).navigator = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" };
    expect(isDesktop()).toBe(true);
  });

  it("returns false in Tauri with mobile user agent", () => {
    (globalThis as Record<string, unknown>).window = { __TAURI__: {} };
    (globalThis as Record<string, unknown>).navigator = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS)" };
    expect(isDesktop()).toBe(false);
  });
});

describe("isMobile", () => {
  afterEach(() => {
    if ("window" in globalThis) {
      delete (globalThis as Record<string, unknown>).window;
    }
    if ("navigator" in globalThis) {
      delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  it("returns false when not in Tauri", () => {
    expect(isMobile()).toBe(false);
  });

  it("returns true in Tauri with iPhone user agent", () => {
    (globalThis as Record<string, unknown>).window = { __TAURI__: {} };
    (globalThis as Record<string, unknown>).navigator = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS)" };
    expect(isMobile()).toBe(true);
  });

  it("returns true in Tauri with Android user agent", () => {
    (globalThis as Record<string, unknown>).window = { __TAURI__: {} };
    (globalThis as Record<string, unknown>).navigator = { userAgent: "Mozilla/5.0 (Linux; Android 13)" };
    expect(isMobile()).toBe(true);
  });

  it("returns true in Tauri with iPad user agent", () => {
    (globalThis as Record<string, unknown>).window = { __TAURI__: {} };
    (globalThis as Record<string, unknown>).navigator = { userAgent: "Mozilla/5.0 (iPad; CPU OS)" };
    expect(isMobile()).toBe(true);
  });

  it("returns false in Tauri with desktop user agent", () => {
    (globalThis as Record<string, unknown>).window = { __TAURI__: {} };
    (globalThis as Record<string, unknown>).navigator = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64)" };
    expect(isMobile()).toBe(false);
  });
});

describe("tauriInvoke", () => {
  afterEach(() => {
    if ("window" in globalThis) {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  it("throws when not in Tauri context", async () => {
    await expect(tauriInvoke("test")).rejects.toThrow("tauriInvoke called outside of Tauri context");
  });

  it("throws when __TAURI__ is undefined", async () => {
    (globalThis as Record<string, unknown>).window = { __TAURI__: undefined };
    await expect(tauriInvoke("test")).rejects.toThrow("window.__TAURI__ not available");
  });

  it("throws when __TAURI__.core is missing", async () => {
    (globalThis as Record<string, unknown>).window = { __TAURI__: {} };
    await expect(tauriInvoke("test")).rejects.toThrow("window.__TAURI__.core.invoke not available");
  });

  it("throws when __TAURI__.core.invoke is missing", async () => {
    (globalThis as Record<string, unknown>).window = { __TAURI__: { core: {} } };
    await expect(tauriInvoke("test")).rejects.toThrow("window.__TAURI__.core.invoke not available");
  });

  it("calls invoke with command and args", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({ success: true });
    (globalThis as Record<string, unknown>).window = {
      __TAURI__: { core: { invoke: mockInvoke } },
    };
    const result = await tauriInvoke("daemon_start", { force: true });
    expect(mockInvoke).toHaveBeenCalledWith("daemon_start", { force: true });
    expect(result).toEqual({ success: true });
  });

  it("calls invoke without args when not provided", async () => {
    const mockInvoke = vi.fn().mockResolvedValue("ok");
    (globalThis as Record<string, unknown>).window = {
      __TAURI__: { core: { invoke: mockInvoke } },
    };
    const result = await tauriInvoke("cli_check");
    expect(mockInvoke).toHaveBeenCalledWith("cli_check", undefined);
    expect(result).toBe("ok");
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

  it("desktop → npx @alook/cli", () => {
    expect(cliCommand("desktop")).toBe("npx @alook/cli");
  });

  it("mobile → npx @alook/cli", () => {
    expect(cliCommand("mobile")).toBe("npx @alook/cli");
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

  it("desktop → no --foreground", () => {
    expect(daemonCommand("desktop")).toBe("npx @alook/cli daemon start");
  });

  it("mobile → no --foreground", () => {
    expect(daemonCommand("mobile")).toBe("npx @alook/cli daemon start");
  });
});

describe("cliPackageName", () => {
  it("app → @alook/app", () => {
    expect(cliPackageName("app")).toBe("@alook/app");
  });

  it("production → @alook/cli", () => {
    expect(cliPackageName("production")).toBe("@alook/cli");
  });

  it("desktop → @alook/cli", () => {
    expect(cliPackageName("desktop")).toBe("@alook/cli");
  });

  it("mobile → @alook/cli", () => {
    expect(cliPackageName("mobile")).toBe("@alook/cli");
  });

  it("dev → @alook/cli", () => {
    expect(cliPackageName("dev")).toBe("@alook/cli");
  });
});

describe("updateCommand", () => {
  it("app → stop, update, start with @alook/app", () => {
    expect(updateCommand("app")).toBe(
      "npx @alook/app stop && npx @alook/app@latest update && npx @alook/app start",
    );
  });

  it("production → daemon stop and start with @alook/cli", () => {
    expect(updateCommand("production")).toBe(
      "npx @alook/cli@latest daemon stop && npx @alook/cli@latest daemon start",
    );
  });

  it("desktop → daemon stop and start with @alook/cli", () => {
    expect(updateCommand("desktop")).toBe(
      "npx @alook/cli@latest daemon stop && npx @alook/cli@latest daemon start",
    );
  });

  it("mobile → daemon stop and start with @alook/cli", () => {
    expect(updateCommand("mobile")).toBe(
      "npx @alook/cli@latest daemon stop && npx @alook/cli@latest daemon start",
    );
  });

  it("dev → daemon stop and start with @alook/cli", () => {
    expect(updateCommand("dev")).toBe(
      "npx @alook/cli@latest daemon stop && npx @alook/cli@latest daemon start",
    );
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
