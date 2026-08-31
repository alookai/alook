import { getCloudflareContext } from "@opennextjs/cloudflare";
import { parseBlogDiscoveryManifest, type BlogDiscoveryManifestV1 } from "@/lib/blog-discovery-manifest";

type BlogDiscoveryRpc = {
	getDiscoveryManifest(): Promise<unknown>;
};

export type BlogDiscoveryClientOptions = {
	worker?: BlogDiscoveryRpc;
	required: boolean;
	timeoutMs?: number;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`Blog discovery RPC timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export async function requestBlogDiscoveryManifest({
	worker,
	required,
	timeoutMs = 3_000,
}: BlogDiscoveryClientOptions): Promise<BlogDiscoveryManifestV1 | null> {
	if (!worker) {
		if (required) throw new Error("BLOG_WORKER binding is unavailable");
		return null;
	}
	const value = await withTimeout(worker.getDiscoveryManifest(), timeoutMs);
	const serialized = JSON.stringify(value);
	return parseBlogDiscoveryManifest(value, serialized);
}

export async function getBlogDiscoveryManifest(): Promise<BlogDiscoveryManifestV1 | null> {
	const { env } = await getCloudflareContext({ async: true });
	return requestBlogDiscoveryManifest({
		worker: env.BLOG_WORKER as unknown as BlogDiscoveryRpc | undefined,
		required: String(env.BLOG_DISCOVERY_REQUIRED) !== "false",
	});
}
