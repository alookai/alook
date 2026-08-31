import { describe, expect, it } from "vitest";
import {
	BLOG_DISCOVERY_MANIFEST_MAX_BYTES,
	createBlogDiscoveryManifest,
	parseBlogDiscoveryManifest,
} from "./blog-discovery-manifest";

const post = {
	slug: "why-we-built-alook",
	title: "Why We Built Alook",
	date: "2026-05-15",
	dateModified: "2026-06-01",
	author: "Gus",
	excerpt: "The origin story.",
	agentSummary: "Use this for the origin story.",
};

describe("Blog discovery manifest", () => {
	it("creates and validates V1 without Blog-only runtime fields", () => {
		const value = createBlogDiscoveryManifest([{ ...post, readingTime: "5 min read" }]);

		expect(parseBlogDiscoveryManifest(value)).toEqual({ version: 1, posts: [post] });
		expect(value.posts[0]).not.toHaveProperty("readingTime");
	});

	it.each([
		[{ version: 1, posts: "invalid" }, "posts"],
		[{ version: 2, posts: [] }, "version"],
		[{ version: 1, posts: [], extra: true }, "shape"],
		[{ version: 1, posts: [{ ...post, draft: true }] }, "shape"],
		[{ version: 1, posts: [{ ...post, slug: "Bad Slug" }] }, "slug"],
		[{ version: 1, posts: [{ ...post, date: "06/01/2026" }] }, "YYYY-MM-DD"],
		[{ version: 1, posts: [{ ...post, date: "2026-02-30" }] }, "date"],
		[{ version: 1, posts: [{ ...post, dateModified: "2026-05-14" }] }, "dateModified before date"],
		[{ version: 1, posts: [{ ...post, title: "" }] }, "non-empty"],
	])("rejects invalid payload %j", (value, message) => {
		expect(() => parseBlogDiscoveryManifest(value)).toThrow(message);
	});

	it("rejects duplicate slugs", () => {
		expect(() => parseBlogDiscoveryManifest({ version: 1, posts: [post, post] }))
			.toThrow("duplicate slug");
	});

	it("rejects payloads over 256 KiB", () => {
		const value = { version: 1, posts: [{ ...post, excerpt: "x".repeat(BLOG_DISCOVERY_MANIFEST_MAX_BYTES) }] };
		expect(() => parseBlogDiscoveryManifest(value)).toThrow("exceeds 256 KiB");
	});

	it("rejects a value that JSON cannot serialize", () => {
		expect(() => parseBlogDiscoveryManifest(undefined)).toThrow("not serializable");
	});
});
