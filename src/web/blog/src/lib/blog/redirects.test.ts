import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blogRedirects } from "./redirects";

describe("blogRedirects", () => {
	it("301s retired blog slugs directly to their replacement", () => {
		expect(blogRedirects()).toEqual([
			{
				source: "/blog/building-your-first-agent-team",
				destination: "/blog/personal-ai-company",
				statusCode: 301,
			},
			{
				source: "/blog/ai-agent-team",
				destination: "/blog/personal-ai-company",
				statusCode: 301,
			},
			{
				source: "/blog/human-ai-collaboration-small-teams",
				destination: "/blog/introducing-alook",
				statusCode: 301,
			},
			{
				source: "/blog/humans-and-ai-agents-in-one-room",
				destination: "/blog/introducing-alook",
				statusCode: 301,
			},
			{
				source: "/blog/what-makes-a-shared-ai-workspace-usable",
				destination: "/blog/introducing-alook",
				statusCode: 301,
			},
		]);
	});
	it("keeps redirect sources retired and destinations final published articles", () => {
		const rules = blogRedirects();
		const sources = new Set(rules.map(({ source }) => source));
		expect(sources.size).toBe(rules.length);
		for (const { source, destination, statusCode } of rules) {
			expect(statusCode).toBe(301);
			expect(sources.has(destination)).toBe(false);
			const article = (route: string) => fileURLToPath(new URL(`../../content/${route.replace("/blog/", "")}.mdx`, import.meta.url));
			expect(existsSync(article(source))).toBe(false);
			expect(existsSync(article(destination))).toBe(true);
		}
	});
});
