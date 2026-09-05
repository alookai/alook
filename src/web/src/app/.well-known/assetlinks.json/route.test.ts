import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("assetlinks.json", () => {
  it("serves the exact Android association only on auth.alook.ai", async () => {
    const response = await GET(
      new Request("https://auth.alook.ai/.well-known/assetlinks.json"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "ai.alook.android",
          sha256_cert_fingerprints: [
            "9D:C6:ED:E9:4B:A6:63:EE:C9:EC:98:FF:7B:AF:D5:5E:24:8B:6C:4B:C2:15:7F:CF:04:2D:F5:9B:0E:41:08:06",
          ],
        },
      },
    ]);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");

    const wrongHost = await GET(
      new Request("https://alook.ai/.well-known/assetlinks.json"),
    );
    expect(wrongHost.status).toBe(404);
  });
});
