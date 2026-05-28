import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /onboard.md", () => {
  it("returns 200 with Content-Type text/markdown", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  });

  it("contains login section", async () => {
    const response = await GET();
    const body = await response.text();
    expect(body).toContain("npx @alook/cli login");
  });

  it("contains daemon start section", async () => {
    const response = await GET();
    const body = await response.text();
    expect(body).toContain("npx @alook/cli daemon start");
  });

  it("contains reflection section with role/domain/tech-stack prompts", async () => {
    const response = await GET();
    const body = await response.text();
    expect(body).toContain("Reflect on Your User");
    expect(body).toContain("role and domain");
    expect(body).toContain("Tech stack");
    expect(body).toContain("workflow");
  });

  it("contains agent recruit section with parameter table", async () => {
    const response = await GET();
    const body = await response.text();
    expect(body).toContain("npx @alook/cli agent recruit");
    expect(body).toContain("--instructions");
    expect(body).toContain("--relationship");
    expect(body).toContain("--name");
    expect(body).toContain("--description");
  });

  it("contains templates exploration section", async () => {
    const response = await GET();
    const body = await response.text();
    expect(body).toContain("https://alook.ai/templates");
  });
});
