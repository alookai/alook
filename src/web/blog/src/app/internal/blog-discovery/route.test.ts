import { describe, expect, it, vi } from "vitest";

vi.mock("@blog/lib/blog/posts", () => ({
	getAllPosts: vi.fn().mockResolvedValue([{
		slug: "why-we-built-alook",
		title: "Why We Built Alook",
		date: "2026-05-15",
		author: "Gus",
		excerpt: "The origin story.",
		readingTime: "5 min read",
		image: "/blog/why-we-built-alook/hero.svg",
	}]),
}));

import { GET, dynamic } from "./route";

describe("GET internal Blog discovery manifest", () => {
	it("emits the static V1 projection", async () => {
		const response = await GET();
		expect(dynamic).toBe("force-static");
		expect(await response.json()).toEqual({
			version: 1,
			posts: [{
				slug: "why-we-built-alook",
				title: "Why We Built Alook",
				date: "2026-05-15",
				author: "Gus",
				excerpt: "The origin story.",
			}],
		});
	});
});
