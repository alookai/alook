import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/blog-worker-client", () => ({
	getBlogDiscoveryManifest: vi.fn(),
}));

import { getBlogDiscoveryManifest } from "@/lib/blog-worker-client";
import { GET } from "./route";

describe("GET /sitemap.xml", () => {
	beforeEach(() => {
		vi.mocked(getBlogDiscoveryManifest).mockReset();
	});

	it("merges fresh Blog discovery once", async () => {
		vi.mocked(getBlogDiscoveryManifest).mockResolvedValue({
			version: 1,
			posts: [{
				slug: "why-we-built-alook",
				title: "Why We Built Alook",
				date: "2026-05-15",
				author: "Gus",
				excerpt: "The origin story.",
			}],
		});

		const response = await GET();
		const body = await response.text();
		expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
		expect(body).toContain("https://alook.ai/blog/why-we-built-alook");
		expect(getBlogDiscoveryManifest).toHaveBeenCalledOnce();
	});

	it("returns main-only XML when discovery is explicitly optional", async () => {
		vi.mocked(getBlogDiscoveryManifest).mockResolvedValue(null);
		const body = await (await GET()).text();
		expect(body).not.toContain("https://alook.ai/blog");
		expect(body).toContain("https://alook.ai/privacy");
	});

	it("fails closed without caching partial XML", async () => {
		vi.mocked(getBlogDiscoveryManifest).mockImplementation(() => {
			throw new Error("invalid manifest");
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const response = await GET();
		expect(response.status).toBe(503);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.text()).not.toContain("<urlset");
		expect(error).toHaveBeenCalledOnce();
		error.mockRestore();
	});
});
