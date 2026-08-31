import { describe, expect, it } from "vitest";
import { blogRedirects } from "./redirects";

describe("blogRedirects", () => {
	it("301s the deleted agent-team slug to ai-agent-team", () => {
		expect(blogRedirects()).toEqual([
			{
				source: "/blog/building-your-first-agent-team",
				destination: "/blog/ai-agent-team",
				statusCode: 301,
			},
		]);
	});
});
