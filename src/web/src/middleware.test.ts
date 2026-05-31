import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: {} })),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({ api: { getSession: mockGetSession } })),
}));

import { middleware } from "./middleware";

/** Build a request with controllable forwarded-proto + headers. */
function makeReq(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

describe("middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("HTTPS enforcement", () => {
    it("301-redirects http → https for non-local hosts", async () => {
      const req = makeReq("http://example.com/w/foo", { "x-forwarded-proto": "http" });
      const res = await middleware(req);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://example.com/w/foo");
    });

    it("does NOT force https for localhost", async () => {
      mockGetSession.mockResolvedValue({ headers: new Headers(), response: null });
      const req = makeReq("http://localhost/w/foo", { "x-forwarded-proto": "http" });
      const res = await middleware(req);
      // localhost is exempt → falls through to auth handling (sign-in redirect), not a 301 https redirect
      expect(res.headers.get("location")).not.toContain("https://localhost")
    });

    it("does NOT force https for 127.x", async () => {
      mockGetSession.mockResolvedValue({ headers: new Headers(), response: null });
      const req = makeReq("http://127.0.0.1/w/foo", { "x-forwarded-proto": "http" });
      const res = await middleware(req);
      expect(res.status).not.toBe(301);
    });
  });

  describe("auth-required routes", () => {
    it("redirects to /sign-in with redirect param when unauthenticated", async () => {
      mockGetSession.mockResolvedValue({ headers: new Headers(), response: null });
      const req = makeReq("https://app.com/w/foo?tab=x", { "x-forwarded-proto": "https" });
      const res = await middleware(req);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/sign-in");
      expect(loc.searchParams.get("redirect")).toBe("/w/foo?tab=x");
    });

    it("omits redirect param when returnTo is /workspaces", async () => {
      mockGetSession.mockResolvedValue({ headers: new Headers(), response: null });
      const req = makeReq("https://app.com/workspaces", { "x-forwarded-proto": "https" });
      const res = await middleware(req);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/sign-in");
      expect(loc.searchParams.get("redirect")).toBeNull();
    });

    it("passes through authenticated requests and forwards refreshed cookies", async () => {
      const setHeaders = new Headers();
      setHeaders.append("set-cookie", "session=abc; Path=/");
      mockGetSession.mockResolvedValue({
        headers: setHeaders,
        response: { user: { id: "u1" } },
      });
      const req = makeReq("https://app.com/dashboard", { "x-forwarded-proto": "https" });
      const res = await middleware(req);
      // NextResponse.next() — no redirect location
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("set-cookie")).toContain("session=abc");
    });

    it("does not require auth for unlisted public paths", async () => {
      const req = makeReq("https://app.com/about", { "x-forwarded-proto": "https" });
      const res = await middleware(req);
      expect(res.headers.get("location")).toBeNull();
      expect(mockGetSession).not.toHaveBeenCalled();
    });
  });

  describe("sign-in redirect when already authenticated (isSafeRedirect guard)", () => {
    async function signInWith(redirectParam: string | null) {
      mockGetSession.mockResolvedValue({
        headers: new Headers(),
        response: { user: { id: "u1" } },
      });
      const qs = redirectParam === null ? "" : `?redirect=${encodeURIComponent(redirectParam)}`;
      const req = makeReq(`https://app.com/sign-in${qs}`, { "x-forwarded-proto": "https" });
      const res = await middleware(req);
      return new URL(res.headers.get("location")!);
    }

    it("accepts a safe same-origin relative path (/w/foo)", async () => {
      const loc = await signInWith("/w/foo");
      expect(loc.pathname).toBe("/w/foo");
    });

    it("rejects protocol-relative //evil.com → falls back to /workspaces", async () => {
      const loc = await signInWith("//evil.com");
      expect(loc.pathname).toBe("/workspaces");
      expect(loc.host).toBe("app.com");
    });

    it("rejects absolute https://evil.com → falls back to /workspaces", async () => {
      const loc = await signInWith("https://evil.com");
      expect(loc.pathname).toBe("/workspaces");
      expect(loc.host).toBe("app.com");
    });

    // Regression guard for the open-redirect bug fixed 2026-05-30 (planner approved + applied):
    // a backslash-prefixed path "/\evil.com" used to pass isSafeRedirect() (starts with "/",
    // not "//"), and the WHATWG URL parser treats "\" as "/", so it resolved to https://evil.com.
    // The guard now rejects any path whose 2nd char is "/" or "\", falling back to /workspaces.
    it("rejects backslash /\\evil.com → falls back to /workspaces (open-redirect guard)", async () => {
      const loc = await signInWith("/\\evil.com");
      expect(loc.pathname).toBe("/workspaces");
      expect(loc.host).toBe("app.com");
    });

    it("does nothing special on /sign-in when unauthenticated", async () => {
      mockGetSession.mockResolvedValue({ headers: new Headers(), response: null });
      const req = makeReq("https://app.com/sign-in", { "x-forwarded-proto": "https" });
      const res = await middleware(req);
      // No session → NextResponse.next(), no redirect
      expect(res.headers.get("location")).toBeNull();
    });
  });
});
