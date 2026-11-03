import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sharedBlogAssets, stageSharedBlogAssets } from "./stage-shared-assets";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("stageSharedBlogAssets", () => {
	it("copies every canonical asset byte-for-byte", () => {
		const root = mkdtempSync(join(tmpdir(), "alook-blog-assets-")); roots.push(root);
		for (const [index, asset] of sharedBlogAssets.entries()) {
			const source = join(root, asset.source);
			mkdirSync(dirname(source), { recursive: true });
			writeFileSync(source, Buffer.from(`asset-${index}\0bytes`));
		}
		writeFileSync(join(root, "package.json"), '{"name":"@alook/web"}');

		stageSharedBlogAssets(root);

		for (const asset of sharedBlogAssets) {
			expect(readFileSync(join(root, asset.destination)))
				.toEqual(readFileSync(join(root, asset.source)));
		}
		expect(existsSync(join(root, "blog/package.json"))).toBe(false);
		symlinkSync("../package.json", join(root, "blog/package.json"), "file");
		stageSharedBlogAssets(root);
		expect(existsSync(join(root, "blog/package.json"))).toBe(false);
	});

	it("preserves and rejects an unknown nested package manifest", () => {
		const root = mkdtempSync(join(tmpdir(), "alook-blog-assets-mismatch-")); roots.push(root);
		for (const [index, asset] of sharedBlogAssets.entries()) {
			const source = join(root, asset.source);
			mkdirSync(dirname(source), { recursive: true });
			writeFileSync(source, Buffer.from(`asset-${index}`));
		}
		mkdirSync(join(root, "blog"), { recursive: true });
		writeFileSync(join(root, "package.json"), '{"name":"@alook/web"}');
		writeFileSync(join(root, "blog/package.json"), '{"name":"wrong"}');

		expect(() => stageSharedBlogAssets(root)).toThrow("Unexpected nested Blog package manifest");
	});
});
