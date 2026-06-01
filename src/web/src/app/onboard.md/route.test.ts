import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET } from "./route";

describe("GET /onboard.md", () => {
  const originalEnv = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalEnv;
    }
  });

  it("returns 200 with Content-Type text/markdown", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  });

  it("uses npx @alook/cli and alook.ai URLs by default", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const response = await GET();
    const body = await response.text();
    expect(body).toContain("npx @alook/cli login");
    expect(body).toContain("https://alook.ai/templates");
    expect(body).toContain("https://alook.ai/w/{slug}");
  });

  it("uses npx @alook/app cli for self-hosted origin", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:15210";
    const response = await GET();
    const body = await response.text();
    expect(body).toContain("npx @alook/app cli login");
    expect(body).toContain("http://localhost:15210/templates");
    expect(body).toContain("http://localhost:15210/w/{slug}");
  });
});
