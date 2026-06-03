import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { GET } from "./route";

function makeRequest(target: string, arch: string, current_version: string) {
  const url = `http://localhost/api/desktop/update/${target}/${arch}/${current_version}`;
  return new Request(url);
}

function makeParams(target: string, arch: string, current_version: string) {
  return { params: Promise.resolve({ target, arch, current_version }) };
}

function makeRelease(version: string, assets: { name: string; browser_download_url: string }[] = []) {
  return {
    draft: false,
    prerelease: false,
    tag_name: `desktop-v${version}`,
    body: "Release notes",
    published_at: "2026-06-01T00:00:00Z",
    assets,
  };
}

describe("GET /api/desktop/update/[target]/[arch]/[current_version]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 502 when GitHub API fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const res = await GET(
      makeRequest("darwin", "aarch64", "1.0.0"),
      makeParams("darwin", "aarch64", "1.0.0"),
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch releases");
  });

  it("returns 204 when no desktop release exists", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ draft: false, prerelease: false, tag_name: "web-v1.0.0", assets: [] }],
    });

    const res = await GET(
      makeRequest("darwin", "aarch64", "1.0.0"),
      makeParams("darwin", "aarch64", "1.0.0"),
    );

    expect(res.status).toBe(204);
  });

  it("returns 204 when current_version is already latest", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeRelease("1.0.0")],
    });

    const res = await GET(
      makeRequest("darwin", "aarch64", "1.0.0"),
      makeParams("darwin", "aarch64", "1.0.0"),
    );

    expect(res.status).toBe(204);
  });

  it("returns 204 when platform/arch combo has no matching asset", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeRelease("2.0.0", [
        { name: "app-windows.msi.zip", browser_download_url: "https://example.com/app.msi.zip" },
      ])],
    });

    const res = await GET(
      makeRequest("freebsd", "arm", "1.0.0"),
      makeParams("freebsd", "arm", "1.0.0"),
    );

    expect(res.status).toBe(204);
  });

  it("returns 204 when binary or sig asset is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeRelease("2.0.0", [
        { name: "app.app.tar.gz", browser_download_url: "https://example.com/app.tar.gz" },
        // no .sig file
      ])],
    });

    const res = await GET(
      makeRequest("darwin", "aarch64", "1.0.0"),
      makeParams("darwin", "aarch64", "1.0.0"),
    );

    expect(res.status).toBe(204);
  });

  it("returns JSON with version, notes, pub_date, platforms when update is available", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeRelease("2.0.0", [
        { name: "app.app.tar.gz", browser_download_url: "https://example.com/app.tar.gz" },
        { name: "app.app.tar.gz.sig", browser_download_url: "https://example.com/app.tar.gz.sig" },
      ])],
    });
    // Signature fetch
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "sig-content-here" });

    const res = await GET(
      makeRequest("darwin", "aarch64", "1.0.0"),
      makeParams("darwin", "aarch64", "1.0.0"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe("2.0.0");
    expect(body.notes).toBe("Release notes");
    expect(body.pub_date).toBe("2026-06-01T00:00:00Z");
    expect(body.platforms["darwin-aarch64"]).toEqual({
      url: "https://example.com/app.tar.gz",
      signature: "sig-content-here",
    });
  });

  it("returns empty signature when sig fetch fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeRelease("2.0.0", [
        { name: "app.app.tar.gz", browser_download_url: "https://example.com/app.tar.gz" },
        { name: "app.app.tar.gz.sig", browser_download_url: "https://example.com/app.tar.gz.sig" },
      ])],
    });
    mockFetch.mockResolvedValueOnce({ ok: false });

    const res = await GET(
      makeRequest("darwin", "aarch64", "1.0.0"),
      makeParams("darwin", "aarch64", "1.0.0"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.platforms["darwin-aarch64"].signature).toBe("");
  });

  describe("compareVersions", () => {
    it("current version newer than release returns 204", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRelease("1.0.0")],
      });

      const res = await GET(
        makeRequest("darwin", "aarch64", "2.0.0"),
        makeParams("darwin", "aarch64", "2.0.0"),
      );

      expect(res.status).toBe(204);
    });

    it("handles versions with different segment lengths", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRelease("1.0.0.1")],
      });
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "sig" });

      const assets = [
        { name: "app.app.tar.gz", browser_download_url: "https://example.com/app.tar.gz" },
        { name: "app.app.tar.gz.sig", browser_download_url: "https://example.com/app.tar.gz.sig" },
      ];
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRelease("1.0.0.1", assets)],
      });
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "sig" });

      const res = await GET(
        makeRequest("darwin", "aarch64", "1.0.0"),
        makeParams("darwin", "aarch64", "1.0.0"),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBe("1.0.0.1");
    });

    it("equal versions return 204", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRelease("1.2.3")],
      });

      const res = await GET(
        makeRequest("darwin", "aarch64", "1.2.3"),
        makeParams("darwin", "aarch64", "1.2.3"),
      );

      expect(res.status).toBe(204);
    });
  });
});
