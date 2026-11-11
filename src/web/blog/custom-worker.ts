import { WorkerEntrypoint } from "cloudflare:workers";
import { parseBlogDiscoveryManifest, type BlogDiscoveryManifestV1 } from "@/lib/blog-discovery-manifest";
import { finalizePublicWorkerResponse } from "@/lib/public-worker-response";

import openNextHandler from "#blog-open-next-worker";
import gonePaths from "./src/lib/blog/gone.json";

const retiredArticlePaths = new Set(gonePaths);

const MANIFEST_PATH = "/internal/blog-discovery";

async function fetchOpenNext(
	request: Request,
	env: BlogCloudflareEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	if (!openNextHandler.fetch) throw new Error("OpenNext Blog fetch handler is unavailable");
	return openNextHandler.fetch(request, env, ctx);
}

export default class BlogWorker extends WorkerEntrypoint<BlogCloudflareEnv> {
	override async fetch(request: Request): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (retiredArticlePaths.has(pathname.replace(/\/$/, ""))) {
			return new Response(request.method === "HEAD" ? null : "This article has been removed. Find current articles at https://alook.ai/blog.\n", {
				status: 410,
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"Cache-Control": "public, max-age=0, must-revalidate",
					"X-Robots-Tag": "noindex",
				},
			});
		}
		if (pathname === MANIFEST_PATH) return new Response("Not Found", { status: 404 });
		const response = await fetchOpenNext(request, this.env, this.ctx);
		const publicDocument = pathname === "/blog" || /^\/tutorials(?:\/[^/.]+)?\/?$/.test(pathname) || /^\/guides\/?$/.test(pathname) || /^\/blog\/[^/.]+\/?$/.test(pathname);
		return finalizePublicWorkerResponse(response, publicDocument, request);
	}

	async getDiscoveryManifest(): Promise<BlogDiscoveryManifestV1> {
		const response = await fetchOpenNext(
			new Request(`https://blog-internal.invalid${MANIFEST_PATH}`),
			this.env,
			this.ctx,
		);
		if (!response.ok) {
			throw new Error(`Blog discovery route returned ${response.status}`);
		}
		const serialized = await response.text();
		return parseBlogDiscoveryManifest(JSON.parse(serialized), serialized);
	}
}
