import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

function makeRequest(url: string) {
  return new NextRequest(new URL(url));
}

describe("GET /onboard.md", () => {
  it("returns 200 with Content-Type text/markdown", async () => {
    const response = await GET(makeRequest("https://alook.ai/onboard.md"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  });

  it("uses npx @alook/cli for cloud origin", async () => {
    const response = await GET(makeRequest("https://alook.ai/onboard.md"));
    const body = await response.text();
    expect(body).toContain("npx @alook/cli login");
    expect(body).toContain("https://alook.ai/templates");
    expect(body).toContain("https://alook.ai/w/{slug}");
  });

  it("uses npx @alook/app cli for self-hosted origin", async () => {
    const response = await GET(makeRequest("http://localhost:15210/onboard.md"));
    const body = await response.text();
    expect(body).toContain("npx @alook/app cli login");
    expect(body).toContain("http://localhost:15210/templates");
    expect(body).toContain("http://localhost:15210/w/{slug}");
  });
});
