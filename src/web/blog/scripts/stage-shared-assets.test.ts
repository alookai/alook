import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sharedBlogAssets, stageSharedBlogAssets } from "./stage-shared-assets";

describe("stageSharedBlogAssets", () => {
	it("copies every canonical asset byte-for-byte", () => {
		const root = mkdtempSync(join(tmpdir(), "alook-blog-assets-"));
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
		expect(readFileSync(join(root, "blog/package.json"), "utf8"))
			.toBe('{"name":"@alook/web"}');
	});
});
