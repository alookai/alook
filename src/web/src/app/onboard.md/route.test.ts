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

  it("contains workspace init section", async () => {
    const response = await GET();
    const body = await response.text();
    expect(body).toContain("npx @alook/cli workspace init --json-file");
    expect(body).toContain("workspace already has agents");
  });

  it("contains templates exploration section", async () => {
    const response = await GET();
    const body = await response.text();
    expect(body).toContain("https://alook.ai/templates");
  });

  it("orders steps correctly: Login → Reflect → Templates/Init → Daemon+URL", async () => {
    const response = await GET();
    const body = await response.text();
    const loginIdx = body.indexOf("## 1. Login");
    const reflectIdx = body.indexOf("## 2. Reflect on Your User");
    const templatesIdx = body.indexOf("## 3. Explore Templates & Set Up Workspace");
    const daemonIdx = body.indexOf("## 4. Start Daemon & Open Workspace");

    expect(loginIdx).toBeGreaterThan(-1);
    expect(reflectIdx).toBeGreaterThan(loginIdx);
    expect(templatesIdx).toBeGreaterThan(reflectIdx);
    expect(daemonIdx).toBeGreaterThan(templatesIdx);
  });

  it("outputs workspace URL after daemon start", async () => {
    const response = await GET();
    const body = await response.text();
    const daemonIdx = body.indexOf("## 4. Start Daemon & Open Workspace");
    const urlIdx = body.indexOf("https://alook.ai/w/{slug}");

    expect(daemonIdx).toBeGreaterThan(-1);
    expect(urlIdx).toBeGreaterThan(daemonIdx);
  });
});
