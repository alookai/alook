import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /.well-known/apple-app-site-association", () => {
  it("returns 200 with application/json content type", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("returns valid applinks structure", async () => {
    const response = await GET();
    const body = await response.json();
    expect(body).toHaveProperty("applinks");
    expect(body.applinks).toHaveProperty("apps", []);
    expect(body.applinks).toHaveProperty("details");
    expect(body.applinks.details).toHaveLength(1);
    expect(body.applinks.details[0]).toEqual({
      appIDs: ["TEAM_ID.ai.alook.app"],
      paths: ["*"],
    });
  });
});
