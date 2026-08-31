import { WorkerEntrypoint } from "cloudflare:workers";
import { parseBlogDiscoveryManifest, type BlogDiscoveryManifestV1 } from "@/lib/blog-discovery-manifest";
import { finalizePublicWorkerResponse } from "@/lib/public-worker-response";

import openNextHandler from "./.open-next/worker.js";

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
		if (pathname === MANIFEST_PATH) return new Response("Not Found", { status: 404 });
		const response = await fetchOpenNext(request, this.env, this.ctx);
		return finalizePublicWorkerResponse(response, true);
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
