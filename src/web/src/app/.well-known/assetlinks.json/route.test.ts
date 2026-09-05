import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /.well-known/assetlinks.json", () => {
  it("returns 200 with application/json content type", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("returns valid asset links structure", async () => {
    const response = await GET();
    const body = await response.json();
    expect(body).toBeInstanceOf(Array);
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "ai.alook.app",
        sha256_cert_fingerprints: ["__PLACEHOLDER__"],
      },
    });
  });
});
