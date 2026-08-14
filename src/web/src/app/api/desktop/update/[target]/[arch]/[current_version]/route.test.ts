import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { GET } from "./route";

interface Asset {
  name: string;
  browser_download_url: string;
}

function makeRequest(
  target: string,
  arch: string,
  currentVersion: string,
  bundleType = "app",
) {
  const url = new URL(
    `http://localhost/api/desktop/update/${target}/${arch}/${currentVersion}`,
  );
  url.searchParams.set("bundle_type", bundleType);
  return new Request(url);
}

function makeParams(target: string, arch: string, currentVersion: string) {
  return { params: Promise.resolve({ target, arch, current_version: currentVersion }) };
}

function makeAsset(name: string): Asset {
  return { name, browser_download_url: `https://example.com/${name}` };
}

function makeRelease(version: string, assets: Asset[] = []) {
  return {
    draft: false,
    prerelease: false,
    tag_name: `v${version}`,
    body: "Release notes",
    published_at: "2026-06-01T00:00:00Z",
    assets,
  };
}

function updaterAssets(...names: string[]) {
  return names.flatMap((name) => [makeAsset(name), makeAsset(`${name}.sig`)]);
}

async function requestUpdate(
  target: string,
  arch: string,
  currentVersion: string,
  bundleType = "app",
) {
  return GET(
    makeRequest(target, arch, currentVersion, bundleType),
    makeParams(target, arch, currentVersion),
  );
}

describe("GET /api/desktop/update/[target]/[arch]/[current_version]", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 502 when GitHub API fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const res = await requestUpdate("darwin", "aarch64", "1.0.0");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Failed to fetch releases" });
  });

  it("returns 204 when no desktop release exists", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { draft: false, prerelease: false, tag_name: "web-v1.0.0", assets: [] },
      ],
    });

    expect((await requestUpdate("darwin", "aarch64", "1.0.0")).status).toBe(204);
  });

  it("returns 204 when current_version is already latest", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeRelease("1.0.0", updaterAssets("Alook_1.0.0_aarch64.app.tar.gz")),
      ],
    });

    expect((await requestUpdate("darwin", "aarch64", "1.0.0")).status).toBe(204);
  });

  it.each([["freebsd", "x86_64", "app"]])(
    "returns 204 for unsupported %s-%s-%s updater targets",
    async (target, arch, bundleType) => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeRelease("2.0.0", updaterAssets("Alook_2.0.0_amd64.AppImage")),
      ],
    });

    expect((await requestUpdate(target, arch, "1.0.0", bundleType)).status).toBe(204);
    expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("returns 204 when the matching binary has no signature asset", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeRelease("2.0.0", [makeAsset("Alook_2.0.0_aarch64.app.tar.gz")])],
    });

    expect((await requestUpdate("darwin", "aarch64", "1.0.0")).status).toBe(204);
  });

  it.each([
    ["darwin", "aarch64", "app", "Alook_2.0.0_aarch64.app.tar.gz"],
    ["darwin", "x86_64", "app", "Alook_2.0.0_x64.app.tar.gz"],
    ["linux", "x86_64", "appimage", "Alook_2.0.0_amd64.AppImage"],
    ["linux", "x86_64", "deb", "Alook_2.0.0_amd64.deb"],
    ["linux", "x86_64", "rpm", "Alook-2.0.0-1.x86_64.rpm"],
    ["windows", "x86_64", "msi", "Alook_2.0.0_x64_en-US.msi"],
    ["windows", "x86_64", "nsis", "Alook_2.0.0_x64-setup.exe"],
  ])(
    "returns the exact Tauri v2 %s-%s-%s artifact and signature",
    async (target, arch, bundleType, assetName) => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRelease("2.0.0", updaterAssets(assetName))],
      });
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "sig-content-here" });

      const res = await requestUpdate(target, arch, "1.0.0", bundleType);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        version: "2.0.0",
        notes: "Release notes",
        pub_date: "2026-06-01T00:00:00Z",
        platforms: {
          [`${target}-${arch}-${bundleType}`]: {
            url: `https://example.com/${assetName}`,
            signature: "sig-content-here",
          },
        },
      });
    },
  );

  it("keeps Windows MSI and NSIS assets distinct", async () => {
    const assets = updaterAssets(
      "Alook_2.0.0_x64_en-US.msi",
      "Alook_2.0.0_x64-setup.exe",
    );
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [makeRelease("2.0.0", assets)] });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "msi-signature" });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [makeRelease("2.0.0", assets)] });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "nsis-signature" });

    const msi = await requestUpdate("windows", "x86_64", "1.0.0", "msi");
    const nsis = await requestUpdate("windows", "x86_64", "1.0.0", "nsis");

    expect((await msi.json()).platforms["windows-x86_64-msi"].url).toContain(".msi");
    expect((await nsis.json()).platforms["windows-x86_64-nsis"].url).toContain("-setup.exe");
  });

  it("keeps Linux package formats distinct from AppImage", async () => {
    const assets = updaterAssets(
      "Alook_2.0.0_amd64.AppImage",
      "Alook_2.0.0_amd64.deb",
      "Alook-2.0.0-1.x86_64.rpm",
    );
    for (const [bundleType, suffix] of [
      ["appimage", ".AppImage"],
      ["deb", ".deb"],
      ["rpm", ".rpm"],
    ] as const) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRelease("2.0.0", assets)],
      });
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => `${bundleType}-signature` });

      const response = await requestUpdate("linux", "x86_64", "1.0.0", bundleType);
      expect((await response.json()).platforms[`linux-x86_64-${bundleType}`].url).toContain(
        suffix,
      );
    }
  });

  it("selects each macOS architecture even when assets are reversed", async () => {
    const assets = updaterAssets(
      "Alook_2.0.0_x64.app.tar.gz",
      "Alook_2.0.0_aarch64.app.tar.gz",
    );
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [makeRelease("2.0.0", assets)] });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "arm-signature" });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [makeRelease("2.0.0", assets)] });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "intel-signature" });

    const arm = await requestUpdate("darwin", "aarch64", "1.0.0");
    const intel = await requestUpdate("darwin", "x86_64", "1.0.0");

    expect((await arm.json()).platforms["darwin-aarch64-app"].url).toContain("aarch64");
    expect((await intel.json()).platforms["darwin-x86_64-app"].url).toContain("x64");
  });

  it("ignores invalid non-SemVer tags and selects the next valid release", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeRelease("1.0.0.1", updaterAssets("Alook_1.0.0.1_aarch64.app.tar.gz")),
        makeRelease("1.1.0", updaterAssets("Alook_1.1.0_aarch64.app.tar.gz")),
      ],
    });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "signature" });

    const res = await requestUpdate("darwin", "aarch64", "1.0.0");

    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe("1.1.0");
  });

  it("returns 204 for an invalid current version", async () => {
    expect((await requestUpdate("darwin", "aarch64", "1.0.0.1")).status).toBe(204);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("searches up to 100 releases and skips interleaved non-desktop releases", async () => {
    const unrelated = Array.from({ length: 12 }, (_, index) => ({
      ...makeRelease(`9.0.${index}`),
      tag_name: `cli-v9.0.${index}`,
    }));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        ...unrelated,
        makeRelease("2.0.0", updaterAssets("Alook_2.0.0_aarch64.app.tar.gz")),
      ],
    });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "signature" });

    const res = await requestUpdate("darwin", "aarch64", "1.0.0");

    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe("2.0.0");
    expect(mockFetch.mock.calls[0][0]).toContain("per_page=100");
  });

  it("selects the highest compatible signed SemVer regardless of API order", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeRelease("1.1.0", updaterAssets("Alook_1.1.0_aarch64.app.tar.gz")),
        makeRelease("3.0.0", [makeAsset("Alook_3.0.0_aarch64.app.tar.gz")]),
        makeRelease("2.0.0", updaterAssets("Alook_2.0.0_aarch64.app.tar.gz")),
      ],
    });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "signature" });

    const res = await requestUpdate("darwin", "aarch64", "1.0.0");

    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe("2.0.0");
  });

  it("returns 502 when signature fetch fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeRelease("2.0.0", updaterAssets("Alook_2.0.0_aarch64.app.tar.gz")),
      ],
    });
    mockFetch.mockResolvedValueOnce({ ok: false });

    const res = await requestUpdate("darwin", "aarch64", "1.0.0");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Failed to fetch update signature" });
  });

  it("returns 502 when the signature body is empty", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeRelease("2.0.0", updaterAssets("Alook_2.0.0_amd64.AppImage")),
      ],
    });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "  \n" });

    const res = await requestUpdate("linux", "x86_64", "1.0.0", "appimage");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Update signature is empty" });
  });

  it("returns 204 when the current version is newer", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeRelease("1.0.0", updaterAssets("Alook_1.0.0_aarch64.app.tar.gz")),
      ],
    });

    expect((await requestUpdate("darwin", "aarch64", "2.0.0")).status).toBe(204);
  });
});
