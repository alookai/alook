import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Blog Tailwind sources", () => {
	it("resolve every explicitly listed shared source", () => {
		const stylesheet = new URL("./globals.css", import.meta.url);
		const css = readFileSync(stylesheet, "utf8");
		const sources = [...css.matchAll(/@source\s+"([^"]+)"/g)].map((match) => match[1]);
		const explicitSources = sources.filter((source) => !source.includes("*"));

		expect(explicitSources).toContain("../../../src/components/public-layout.tsx");
		for (const source of explicitSources) {
			expect(existsSync(new URL(source, stylesheet)), source).toBe(true);
		}
	});
});
