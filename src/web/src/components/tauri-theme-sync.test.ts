import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@alook/shared", () => ({
  isDesktop: () => true,
  isTauri: () => true,
  tauriInvoke: mocks.invoke,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

import { syncTauriWindowTheme } from "./tauri-theme-sync";

describe("syncTauriWindowTheme", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("sends the legacy startup notification after applying the native theme", async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await syncTauriWindowTheme(true);

    expect(mocks.invoke.mock.calls).toEqual([
      ["set_window_theme", { dark: true }],
      ["close_splashscreen"],
    ]);
  });

  it("still sends the legacy startup notification when the native theme rejects", async () => {
    mocks.invoke
      .mockRejectedValueOnce(new Error("theme unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(syncTauriWindowTheme(false)).rejects.toThrow("theme unavailable");
    expect(mocks.invoke.mock.calls).toEqual([
      ["set_window_theme", { dark: false }],
      ["close_splashscreen"],
    ]);
  });

  it("keeps a successful theme result when the legacy notification rejects", async () => {
    mocks.invoke
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("startup notification unavailable"));

    await expect(syncTauriWindowTheme(true)).resolves.toBeUndefined();
    expect(mocks.invoke.mock.calls).toEqual([
      ["set_window_theme", { dark: true }],
      ["close_splashscreen"],
    ]);
  });

  it("keeps the original theme failure when the legacy notification also rejects", async () => {
    const themeError = new Error("theme unavailable");
    mocks.invoke
      .mockRejectedValueOnce(themeError)
      .mockRejectedValueOnce(new Error("startup notification unavailable"));

    await expect(syncTauriWindowTheme(false)).rejects.toBe(themeError);
    expect(mocks.invoke.mock.calls).toEqual([
      ["set_window_theme", { dark: false }],
      ["close_splashscreen"],
    ]);
  });
});
