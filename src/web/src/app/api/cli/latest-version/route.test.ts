import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { GET } from "./route";

describe("GET /api/cli/latest-version", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns version and package from npm registry", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "2.0.0" }),
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.version).toBe("2.0.0");
    expect(body.package).toBe("@alook/cli");
  });

  it("returns 502 when npm registry returns non-ok", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("failed to fetch");
  });

  it("returns 502 when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("failed to fetch");
  });

  it("returns 502 when response has no version field", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: "@alook/cli" }),
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("version");
  });
});
