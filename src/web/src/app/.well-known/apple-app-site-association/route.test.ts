import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("apple-app-site-association", () => {
  it("serves the exact iOS return association only on auth.alook.ai", async () => {
    const response = await GET(
      new Request("https://auth.alook.ai/.well-known/apple-app-site-association"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      applinks: {
        apps: [],
        details: [
          {
            appID: "5RF24VHDQB.ai.alook.ios",
            components: [
              {
                "/": "/auth/native/return",
                comment: "Native OAuth handoff return",
              },
            ],
          },
        ],
      },
    });
    expect(response.headers.get("Cache-Control")).toContain("no-store");

    const wrongHost = await GET(
      new Request("https://alook.ai/.well-known/apple-app-site-association"),
    );
    expect(wrongHost.status).toBe(404);
  });
});
