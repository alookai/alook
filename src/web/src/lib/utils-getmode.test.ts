import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockIsTauri = vi.fn(() => false);
const mockIsMobile = vi.fn(() => false);
const mockResolveMode = vi.fn(() => "production" as const);

vi.mock("@alook/shared", () => ({
  resolveMode: (...args: any[]) => mockResolveMode(...args),
  cliCommand: vi.fn(() => "npx @alook/cli"),
  daemonCommand: vi.fn(() => "npx @alook/cli daemon start"),
  isTauri: (...args: any[]) => mockIsTauri(...args),
  isMobile: (...args: any[]) => mockIsMobile(...args),
}));

import { getAppMode } from "./utils";

describe("getAppMode", () => {
  let originalWindow: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveMode.mockReturnValue("production");
    originalWindow = (globalThis as any).window;
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
  });

  it("returns the resolved mode", () => {
    mockResolveMode.mockReturnValue("production");
    expect(getAppMode()).toBe("production");
  });

  it("returns desktop mode when Tauri globals are set", () => {
    (globalThis as any).window = { __TAURI__: {}, location: { hostname: "tauri.localhost" } };
    mockIsTauri.mockReturnValue(true);
    mockIsMobile.mockReturnValue(false);
    mockResolveMode.mockReturnValue("desktop");

    expect(getAppMode()).toBe("desktop");
    expect(mockResolveMode).toHaveBeenCalledWith(
      expect.objectContaining({ tauri: true, tauriPlatform: "desktop" }),
    );
  });

  it("returns mobile mode when Tauri + mobile globals are set", () => {
    (globalThis as any).window = { __TAURI__: {}, location: { hostname: "tauri.localhost" } };
    mockIsTauri.mockReturnValue(true);
    mockIsMobile.mockReturnValue(true);
    mockResolveMode.mockReturnValue("mobile");

    expect(getAppMode()).toBe("mobile");
    expect(mockResolveMode).toHaveBeenCalledWith(
      expect.objectContaining({ tauri: true, tauriPlatform: "mobile" }),
    );
  });
});
