import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/blog-worker-client", () => ({
	getBlogDiscoveryManifest: vi.fn(),
}));

import { getBlogDiscoveryManifest } from "@/lib/blog-worker-client";
import { GET } from "./route";

describe("GET /llms.txt", () => {
  beforeEach(() => {
		vi.mocked(getBlogDiscoveryManifest).mockReset();
  });

  it("returns markdown with blog posts and correct content type", async () => {
		vi.mocked(getBlogDiscoveryManifest).mockResolvedValue({
			version: 1,
			posts: [{
				slug: "why-we-built-alook",
        title: "Why We Built Alook",
        date: "2026-05-15",
        author: "Gus",
        excerpt: "Origin story excerpt.",
			}],
		});

    const res = await GET();
    const body = await res.text();

    expect(res.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8"
    );
    expect(body).toContain("# Alook");
		expect(body).toContain(
			"[Why We Built Alook](https://alook.ai/blog/why-we-built-alook)"
		);
		expect(getBlogDiscoveryManifest).toHaveBeenCalledOnce();
	});

	it("returns deterministic main-only output for self-hosting", async () => {
		vi.mocked(getBlogDiscoveryManifest).mockResolvedValue(null);
		const response = await GET();
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).not.toContain("## Blog posts");
		expect(body).toContain("# Alook");
	});

	it("fails closed without caching partial output", async () => {
		vi.mocked(getBlogDiscoveryManifest).mockRejectedValue(new Error("RPC failed"));
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const response = await GET();
		expect(response.status).toBe(503);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.text()).not.toContain("## Key pages");
		expect(error).toHaveBeenCalledOnce();
		error.mockRestore();
	});
});
