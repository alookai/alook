/// <reference types="@cloudflare/vitest-plugin/types" />

import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = (exports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
}).default;

const ATTEMPT = "attempt_1234567890123456";
const CODE = "c".repeat(32);

describe("alook-auth workerd runtime", () => {
  it("serves an exact association resource without bindings", async () => {
    const response = await worker.fetch(new Request(
      "https://auth.alook.ai/.well-known/apple-app-site-association",
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toMatchObject({
      applinks: { details: [{ appID: "5RF24VHDQB.ai.alook.ios" }] },
    });
  });

  it("keeps a real handoff code out of the rendered fallback DOM source", async () => {
    const response = await worker.fetch(new Request(
      `https://auth.alook.ai/auth/native/return?attempt=${ATTEMPT}&code=${CODE}`,
    ));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("data-open-alook");
    expect(body).not.toContain(ATTEMPT);
    expect(body).not.toContain(CODE);
    expect(body).not.toMatch(/href=["']ai\.alook:/);
  });

  it("returns a bodyless private 404 before any other runtime for a disallowed request", async () => {
    const response = await worker.fetch(new Request(
      "https://auth.alook.ai/sign-in?code=secret",
      { method: "HEAD" },
    ));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(await response.text()).toBe("");
  });
});
