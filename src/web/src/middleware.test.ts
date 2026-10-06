import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: {} })),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getAuth: vi.fn(() => ({ api: { getSession: mockGetSession } })),
}));

import { config, middleware } from "./middleware";

/** Build a request with controllable forwarded-proto + headers. */
function makeReq(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

describe("middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("HTTPS enforcement", () => {
    it("301-redirects http → https for non-local hosts", async () => {
      const req = makeReq("http://example.com/c/me", { "x-forwarded-proto": "http" });
      const res = await middleware(req);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://example.com/c/me");
    });

    it("does NOT force https for localhost", async () => {
      mockGetSession.mockResolvedValue({ headers: new Headers(), response: null });
      const req = makeReq("http://localhost/c/me", { "x-forwarded-proto": "http" });
      const res = await middleware(req);
      // localhost is exempt → falls through to auth handling (sign-in redirect), not a 301 https redirect
      expect(res.headers.get("location")).not.toContain("https://localhost")
    });

    it("does NOT force https for 127.x", async () => {
      mockGetSession.mockResolvedValue({ headers: new Headers(), response: null });
      const req = makeReq("http://127.0.0.1/c/me", { "x-forwarded-proto": "http" });
      const res = await middleware(req);
      expect(res.status).not.toBe(301);
    });
  });

  describe("auth-required routes", () => {
    it.each(["/w", "/w/sample/home", "/w/sample.name/home", "/w/sample/agents/a/chat/b", "/w/sample/%broken", "/%77/sample/home", "/workspaces", "/dashboard", "/studio/new", "/studio/new/", "/invite/old-token"])("leaves deleted frontend path %s to ordinary route handling without looking up a session", async path => {
      for (const response of [null, { user: { id: "viewer" } }]) {
        mockGetSession.mockResolvedValue({ headers: new Headers({ "set-cookie": "session=renewed; Path=/" }), response });
        const res = await middleware(makeReq(`https://app.com${path}?token=private&workspace_id=private`));
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("x-middleware-next")).toBe("1");
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(mockGetSession).not.toHaveBeenCalled();
      }
    });
    it("redirects to /sign-in with redirect param when unauthenticated", async () => {
      mockGetSession.mockResolvedValue({ headers: new Headers(), response: null });
      const req = makeReq("https://app.com/c/me?tab=x", { "x-forwarded-proto": "https" });
      const res = await middleware(req);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/sign-in");
      expect(loc.searchParams.get("redirect")).toBe("/c/me?tab=x");
    });

    it("passes through authenticated requests and forwards refreshed cookies", async () => {
      const setHeaders = new Headers();
      setHeaders.append("set-cookie", "session=abc; Path=/");
      mockGetSession.mockResolvedValue({
        headers: setHeaders,
        response: { user: { id: "u1" } },
      });
      const req = makeReq("https://app.com/c/me", { "x-forwarded-proto": "https" });
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

    it("serves /c/invite/<token> anonymously (preview-first, no login wall)", async () => {
      // The invite landing page is public even though it's under /c/ — a
      // logged-out visitor must SEE the invite and only hit login on Join.
      const req = makeReq("https://app.com/c/invite/tok_1", { "x-forwarded-proto": "https" });
      const res = await middleware(req);
      expect(res.headers.get("location")).toBeNull();
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("still gates the rest of /c/ (the public exemption is scoped to /c/invite/)", async () => {
      mockGetSession.mockResolvedValue({ headers: new Headers(), response: null });
      const req = makeReq("https://app.com/c/channels/s1", { "x-forwarded-proto": "https" });
      const res = await middleware(req);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/sign-in");
      expect(loc.searchParams.get("redirect")).toBe("/c/channels/s1");
    });
  });

  describe("Next route matcher", () => {
    it.each(["/c/me", "/sign-in", "/w", "/studio/new"])("runs the ordinary middleware matcher for %s", url => {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    });
    it.each(["/favicon.ico", "/_next/static/chunk.js", "/images/logo.png", "/about.pdf", "/w/sample.name/home", "/w/sample/agents/a.name/chat/b.json"])("retains the ordinary dotted-path exclusion for %s", url => {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
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

    it("keeps a supplied safe same-origin return path", async () => {
      const loc = await signInWith("/removed/page");
      expect(loc.pathname).toBe("/removed/page");
    });

    it("rejects protocol-relative //evil.com → falls back to /c/me", async () => {
      const loc = await signInWith("//evil.com");
      expect(loc.pathname).toBe("/c/me");
      expect(loc.host).toBe("app.com");
    });

    it("rejects absolute https://evil.com → falls back to /c/me", async () => {
      const loc = await signInWith("https://evil.com");
      expect(loc.pathname).toBe("/c/me");
      expect(loc.host).toBe("app.com");
    });

    // Regression guard for the open-redirect bug fixed 2026-05-30 (planner approved + applied):
    // a backslash-prefixed path "/\evil.com" used to pass isSafeRedirect() (starts with "/",
    // not "//"), and the WHATWG URL parser treats "\" as "/", so it resolved to https://evil.com.
    // The guard now rejects any path whose 2nd char is "/" or "\", falling back to the default.
    it("rejects backslash /\\evil.com → falls back to /c/me (open-redirect guard)", async () => {
      const loc = await signInWith("/\\evil.com");
      expect(loc.pathname).toBe("/c/me");
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
