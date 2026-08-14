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

  it("closes the splash after applying the native theme", async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await syncTauriWindowTheme(true);

    expect(mocks.invoke.mock.calls).toEqual([
      ["set_window_theme", { dark: true }],
      ["close_splashscreen"],
    ]);
  });

  it("still closes the splash when native theme application rejects", async () => {
    mocks.invoke
      .mockRejectedValueOnce(new Error("theme unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(syncTauriWindowTheme(false)).rejects.toThrow("theme unavailable");
    expect(mocks.invoke.mock.calls).toEqual([
      ["set_window_theme", { dark: false }],
      ["close_splashscreen"],
    ]);
  });
});
