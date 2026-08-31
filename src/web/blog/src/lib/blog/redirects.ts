export type BlogRedirect = {
	source: string;
	destination: string;
	statusCode: 301;
};

/** Permanent blog slug redirects for Next.js `redirects()`. */
export function blogRedirects(): BlogRedirect[] {
	return blogRedirectRules as BlogRedirect[];
}
import blogRedirectRules from "./redirects.json";
