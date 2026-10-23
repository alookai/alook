import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageBlogCacheAssets } from "./stage-cache-assets";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "blog-cache-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Blog static cache packaging", () => {
	it("copies generated entries byte-for-byte and removes old build entries", () => {
		const root = fixture();
		mkdirSync(join(root, "cache/new-build"), { recursive: true });
		writeFileSync(join(root, "cache/new-build/page.cache"), "cached document\0payload");
		mkdirSync(join(root, "assets/cdn-cgi/_next_cache/old-build"), { recursive: true });
		writeFileSync(join(root, "assets/keep.txt"), "public asset");
		stageBlogCacheAssets(root);
		expect(readFileSync(join(root, "assets/cdn-cgi/_next_cache/new-build/page.cache"), "utf8"))
			.toBe("cached document\0payload");
		expect(existsSync(join(root, "assets/cdn-cgi/_next_cache/old-build"))).toBe(false);
		expect(readFileSync(join(root, "assets/keep.txt"), "utf8")).toBe("public asset");
	});
	it("fails the build if generated cache is missing or empty", () => {
		const root = fixture();
		expect(() => stageBlogCacheAssets(root)).toThrow("no prerendered cache");
		mkdirSync(join(root, "cache"));
		expect(() => stageBlogCacheAssets(root)).toThrow("no prerendered cache");
	});
});
