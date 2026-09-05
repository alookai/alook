import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderFaceSvg } from "../src/lib/avatar/face";
import handler, {
  ANDROID_ASSET_LINKS,
  APPLE_APP_SITE_ASSOCIATION,
  AUTH_RETURN_AVATAR_SEEDS,
  AUTH_WORKER_AASA_PATH,
  AUTH_WORKER_ASSET_LINKS_PATH,
  AUTH_WORKER_RETURN_PATH,
} from "./index";

const ATTEMPT = "attempt_1234567890123456";
const CODE = "c".repeat(32);
const CANONICAL_LOGO = readFileSync(
  new URL("../public/alook.svg", import.meta.url),
  "utf8",
).trim();
const DM_SANS_WOFF2 = readFileSync(
  new URL("../src/app/fonts/dm-sans-latin.woff2", import.meta.url),
).toString("base64");
const CAVEAT_WOFF2 = readFileSync(
  new URL("../src/app/fonts/caveat-latin.woff2", import.meta.url),
).toString("base64");

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://auth.alook.ai${path}`, init);
}

async function fetch(path: string, init?: RequestInit): Promise<Response> {
  return handler.fetch(request(path, init));
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
}

describe("alook-auth Worker", () => {
  it.each([
    [AUTH_WORKER_AASA_PATH, APPLE_APP_SITE_ASSOCIATION],
    [AUTH_WORKER_ASSET_LINKS_PATH, ANDROID_ASSET_LINKS],
  ])("serves the exact association payload at %s", async (path, expected) => {
    const response = await fetch(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expectPrivate(response);
    await expect(response.json()).resolves.toEqual(expected);
  });

  it("serves association HEAD responses without a body", async () => {
    const response = await fetch(AUTH_WORKER_AASA_PATH, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expectPrivate(response);
    expect(await response.text()).toBe("");
  });

  it.each([
    `?attempt=${ATTEMPT}&code=${CODE}`,
    `?attempt=${ATTEMPT}&status=access_denied`,
  ])("renders a static launch control without serializing return values for %s", async (query) => {
    const response = await fetch(`${AUTH_WORKER_RETURN_PATH}${query}`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectPrivate(response);
    expect(body).toContain("data-open-alook");
    expect(body).toContain("Open Alook");
    expect(body).not.toContain(ATTEMPT);
    expect(body).not.toContain(CODE);
    expect(body).not.toContain("access_denied");
    expect(body).not.toMatch(/href=["']ai\.alook:/);

    const script = body.match(/<script>([\s\S]+)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const digest = createHash("sha256").update(script!).digest("base64");
    expect(response.headers.get("Content-Security-Policy"))
      .toContain(`script-src 'sha256-${digest}'`);
    expect(response.headers.get("Content-Security-Policy"))
      .toContain("script-src 'sha256-5yRFm/Mu9yL952eR8mqLHHTJZnHDNb5SC5aES535aMk='");
  });

  it("reuses canonical Alook branding and disables ambient motion on request", async () => {
    const response = await fetch(`${AUTH_WORKER_RETURN_PATH}?attempt=${ATTEMPT}&code=${CODE}`);
    const body = await response.text();
    const csp = response.headers.get("Content-Security-Policy")!;

    expect(body).toContain(CANONICAL_LOGO);
    expect(body).toContain(`src: url("data:font/woff2;base64,${DM_SANS_WOFF2}")`);
    expect(body).toContain(`src: url("data:font/woff2;base64,${CAVEAT_WOFF2}")`);
    expect(body.match(/data:font\/woff2;base64,/g)).toHaveLength(2);
    expect(body).toContain('font-family: "DM Sans", ui-sans-serif');
    expect(body).toContain('font-family: "Caveat", cursive; font-size: 30px; font-weight: 700;');
    expect(body).toContain("button {\n    width: 100%;");
    expect(body).toContain("font: inherit;");
    expect(csp.split("; ")).toContain("font-src data:");
    expect(body).toContain('<meta name="color-scheme" content="light dark">');
    expect(body).toContain('class="avatar-field" aria-hidden="true"');
    expect(body.match(/class="avatar avatar-\d"/g)).toHaveLength(
      AUTH_RETURN_AVATAR_SEEDS.length,
    );
    for (const seed of AUTH_RETURN_AVATAR_SEEDS) {
      expect(body).toContain(renderFaceSvg(seed));
      expect(body).not.toContain(seed);
    }
    expect(body).toContain("@media (prefers-color-scheme: dark)");
    expect(body).toContain("@media (prefers-reduced-motion: reduce)");
    expect(body).toMatch(/\.avatar-field \{[\s\S]*?pointer-events: none;[\s\S]*?\}/);
    expect(body).toMatch(/\.avatar \{ animation: none; transform: none; will-change: auto; \}/);
    expect(body).toContain("min-height: 48px");
    expect(body).toContain("button:focus-visible");
    expect(body.match(/<script>/g)).toHaveLength(1);
    expect(body).not.toMatch(/<(?:img|link)\b/i);
  });

  it.each([
    "",
    `?attempt=bad&code=${CODE}`,
    `?attempt=${ATTEMPT}&code=bad`,
    `?attempt=${ATTEMPT}&status=not-a-status`,
    `?attempt=${ATTEMPT}&code=${CODE}&status=access_denied`,
    `?attempt=${ATTEMPT}&code=${CODE}&extra=1`,
    `?attempt=${ATTEMPT}&attempt=${ATTEMPT}&code=${CODE}`,
  ])("renders no launch control for invalid return query %s", async (query) => {
    const response = await fetch(`${AUTH_WORKER_RETURN_PATH}${query}`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(body).toContain(CANONICAL_LOGO);
    expect(body).toContain('class="avatar-field" aria-hidden="true"');
    expect(body).toContain("This sign-in link is invalid.");
    expect(body).not.toContain("expired");
    expect(body).not.toContain("data-open-alook");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain(CODE);
  });

  it.each([
    ["GET", "https://alook.ai/auth/native/return"],
    ["GET", "http://auth.alook.ai/auth/native/return"],
    ["GET", "https://auth.alook.ai:444/auth/native/return"],
    ["GET", "https://auth.alook.ai/"],
    ["GET", "https://auth.alook.ai/sign-in"],
    ["GET", `https://auth.alook.ai${AUTH_WORKER_AASA_PATH}?query=1`],
    ["POST", `https://auth.alook.ai${AUTH_WORKER_RETURN_PATH}`],
    ["OPTIONS", `https://auth.alook.ai${AUTH_WORKER_ASSET_LINKS_PATH}`],
  ])("returns private 404 for %s %s", async (method, url) => {
    const response = await handler.fetch(new Request(url, { method }));
    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
    expectPrivate(response);
  });

  it("does not call console APIs while handling a handoff URL", async () => {
    const spies = ["debug", "info", "log", "warn", "error"].map((method) => (
      vi.spyOn(console, method as "log").mockImplementation(() => undefined)
    ));
    try {
      await fetch(`${AUTH_WORKER_RETURN_PATH}?attempt=${ATTEMPT}&code=${CODE}`);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
