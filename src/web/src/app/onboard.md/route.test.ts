import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /onboard.md", () => {
  it("returns 200 with Content-Type text/markdown", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  });
});
