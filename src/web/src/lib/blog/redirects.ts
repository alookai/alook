export type BlogRedirect = {
	source: string;
	destination: string;
	statusCode: 301;
};

/** Permanent blog slug redirects for Next.js `redirects()`. */
export function blogRedirects(): BlogRedirect[] {
	return [
		{
			source: "/blog/building-your-first-agent-team",
			destination: "/blog/ai-agent-team",
			statusCode: 301,
		},
	];
}
