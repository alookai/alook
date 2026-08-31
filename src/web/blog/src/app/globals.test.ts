import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Blog Tailwind sources", () => {
	it("includes the complete main-app source tree", () => {
		const stylesheet = new URL("./globals.css", import.meta.url);
		const css = readFileSync(stylesheet, "utf8");
		const sources = [...css.matchAll(/@source\s+"([^"]+)"/g)].map((match) => match[1]);

		expect(sources).toContain("../../../src/**/*.{ts,tsx,mdx}");
		expect(existsSync(new URL("../../../src/", stylesheet))).toBe(true);
	});
});
