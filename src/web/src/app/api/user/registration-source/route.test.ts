import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockUpdateRegistrationSource = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      user: {
        updateRegistrationSource: (...args: unknown[]) =>
          mockUpdateRegistrationSource(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server");
  const actual = await vi.importActual("@/lib/middleware/helpers");
  return {
    ...actual,
    writeJSON: (data: unknown, status = 200) =>
      NextResponse.json(data, { status }),
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  };
});

import { POST } from "./route";

describe("POST /api/user/registration-source", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates user with utm params and referrer", async () => {
    mockUpdateRegistrationSource.mockResolvedValue({ id: "u1" });

    const req = new NextRequest("http://localhost/api/user/registration-source", {
      method: "POST",
      body: JSON.stringify({
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "launch",
        referrer: "https://google.com/search",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: true });
    expect(mockUpdateRegistrationSource).toHaveBeenCalledWith({}, "u1", {
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "launch",
      referrer: "https://google.com/search",
    });
  });

  it("returns updated:false when no values provided", async () => {
    const req = new NextRequest("http://localhost/api/user/registration-source", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: false });
    expect(mockUpdateRegistrationSource).not.toHaveBeenCalled();
  });

  it("returns updated:false when all values are null", async () => {
    const req = new NextRequest("http://localhost/api/user/registration-source", {
      method: "POST",
      body: JSON.stringify({
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        referrer: null,
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: false });
    expect(mockUpdateRegistrationSource).not.toHaveBeenCalled();
  });

  it("returns updated:false when source already set (first-write-wins)", async () => {
    mockUpdateRegistrationSource.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/user/registration-source", {
      method: "POST",
      body: JSON.stringify({ utm_source: "twitter" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: false });
  });

  it("handles partial UTM params (only referrer)", async () => {
    mockUpdateRegistrationSource.mockResolvedValue({ id: "u1" });

    const req = new NextRequest("http://localhost/api/user/registration-source", {
      method: "POST",
      body: JSON.stringify({ referrer: "https://news.ycombinator.com" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: true });
    expect(mockUpdateRegistrationSource).toHaveBeenCalledWith({}, "u1", {
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      referrer: "https://news.ycombinator.com",
    });
  });

  it("returns 400 for invalid body", async () => {
    const req = new NextRequest("http://localhost/api/user/registration-source", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(400);
  });
});
