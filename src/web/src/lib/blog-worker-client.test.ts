import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));

vi.mock("@opennextjs/cloudflare", () => ({
	getCloudflareContext: mocks.getCloudflareContext,
}));

import { getBlogDiscoveryManifest, requestBlogDiscoveryManifest } from "./blog-worker-client";

const manifest = {
	version: 1 as const,
	posts: [{
		slug: "why-we-built-alook",
		title: "Why We Built Alook",
		date: "2026-05-15",
		author: "Gus",
		excerpt: "The origin story.",
	}],
};

describe("Blog discovery RPC client", () => {
	it("calls the binding once and validates the response", async () => {
		const getDiscoveryManifest = vi.fn().mockResolvedValue(manifest);
		await expect(requestBlogDiscoveryManifest({
			worker: { getDiscoveryManifest },
			required: true,
		})).resolves.toEqual(manifest);
		expect(getDiscoveryManifest).toHaveBeenCalledOnce();
	});

	it("fails closed when the required binding is unavailable", async () => {
		await expect(requestBlogDiscoveryManifest({ required: true }))
			.rejects.toThrow("binding is unavailable");
	});

	it("returns main-only mode when the binding is explicitly optional", async () => {
		await expect(requestBlogDiscoveryManifest({ required: false })).resolves.toBeNull();
	});

	it("times out a stalled RPC", async () => {
		await expect(requestBlogDiscoveryManifest({
			worker: { getDiscoveryManifest: () => new Promise(() => undefined) },
			required: true,
			timeoutMs: 1,
		})).rejects.toThrow("timed out");
	});

	it("reads the binding and required mode from the Cloudflare context", async () => {
		const getDiscoveryManifest = vi.fn().mockResolvedValue(manifest);
		mocks.getCloudflareContext.mockResolvedValue({
			env: { BLOG_WORKER: { getDiscoveryManifest }, BLOG_DISCOVERY_REQUIRED: "true" },
		});

		await expect(getBlogDiscoveryManifest()).resolves.toEqual(manifest);
		expect(mocks.getCloudflareContext).toHaveBeenCalledWith({ async: true });
		expect(getDiscoveryManifest).toHaveBeenCalledOnce();
	});
});
