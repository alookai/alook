const BLOG_DISCOVERY_MANIFEST_VERSION = 1 as const;
export const BLOG_DISCOVERY_MANIFEST_MAX_BYTES = 256 * 1024;

export type BlogDiscoveryPostV1 = {
	slug: string;
	title: string;
	date: string;
	dateModified?: string;
	author: string;
	excerpt: string;
	agentSummary?: string;
};

export type BlogDiscoveryManifestV1 = {
	version: typeof BLOG_DISCOVERY_MANIFEST_VERSION;
	posts: BlogDiscoveryPostV1[];
};

const MANIFEST_KEYS = new Set(["version", "posts"]);
const POST_KEYS = new Set([
	"slug",
	"title",
	"date",
	"dateModified",
	"author",
	"excerpt",
	"agentSummary",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Blog discovery field ${field} must be a non-empty string`);
	}
	return value;
}

function isoDate(value: unknown, field: string): string {
	const date = requiredString(value, field);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`Blog discovery field ${field} must be a YYYY-MM-DD date`);
	}
	const parsed = new Date(`${date}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
		throw new Error(`Blog discovery field ${field} must be a valid date`);
	}
	return date;
}

export function createBlogDiscoveryManifest(
	posts: readonly BlogDiscoveryPostV1[],
): BlogDiscoveryManifestV1 {
	return {
		version: BLOG_DISCOVERY_MANIFEST_VERSION,
		posts: posts.map((post) => ({
			slug: post.slug,
			title: post.title,
			date: post.date,
			...(post.dateModified ? { dateModified: post.dateModified } : {}),
			author: post.author,
			excerpt: post.excerpt,
			...(post.agentSummary ? { agentSummary: post.agentSummary } : {}),
		})),
	};
}

export function parseBlogDiscoveryManifest(
	value: unknown,
	serialized = JSON.stringify(value),
): BlogDiscoveryManifestV1 {
	if (typeof serialized !== "string") {
		throw new Error("Blog discovery manifest is not serializable");
	}
	if (new TextEncoder().encode(serialized).byteLength > BLOG_DISCOVERY_MANIFEST_MAX_BYTES) {
		throw new Error("Blog discovery manifest exceeds 256 KiB");
	}
	if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) {
		throw new Error("Blog discovery manifest has an unexpected shape");
	}
	if (value.version !== BLOG_DISCOVERY_MANIFEST_VERSION) {
		throw new Error("Unsupported Blog discovery manifest version");
	}
	if (!Array.isArray(value.posts)) {
		throw new Error("Blog discovery manifest posts must be an array");
	}

	const slugs = new Set<string>();
	const posts = value.posts.map((rawPost, index): BlogDiscoveryPostV1 => {
		if (!isRecord(rawPost) || !hasExactKeys(rawPost, POST_KEYS)) {
			throw new Error(`Blog discovery post ${index} has an unexpected shape`);
		}
		const slug = requiredString(rawPost.slug, `posts[${index}].slug`);
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
			throw new Error(`Blog discovery post ${index} has an invalid slug`);
		}
		if (slugs.has(slug)) {
			throw new Error(`Blog discovery manifest has duplicate slug ${slug}`);
		}
		slugs.add(slug);

		const date = isoDate(rawPost.date, `posts[${index}].date`);
		const dateModified = rawPost.dateModified === undefined
			? undefined
			: isoDate(rawPost.dateModified, `posts[${index}].dateModified`);
		if (dateModified && dateModified < date) {
			throw new Error(`Blog discovery post ${index} has dateModified before date`);
		}

		return {
			slug,
			title: requiredString(rawPost.title, `posts[${index}].title`),
			date,
			...(dateModified ? { dateModified } : {}),
			author: requiredString(rawPost.author, `posts[${index}].author`),
			excerpt: requiredString(rawPost.excerpt, `posts[${index}].excerpt`),
			...(rawPost.agentSummary === undefined
				? {}
				: { agentSummary: requiredString(rawPost.agentSummary, `posts[${index}].agentSummary`) }),
		};
	});

	return { version: BLOG_DISCOVERY_MANIFEST_VERSION, posts };
}
