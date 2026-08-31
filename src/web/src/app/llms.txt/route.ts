import { getBlogDiscoveryManifest } from "@/lib/blog-worker-client";
import { buildRootLlmsTxt, LLMS_TXT_SITE_URL } from "@/lib/root-llms";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		const manifest = await getBlogDiscoveryManifest();
		return new Response(buildRootLlmsTxt(manifest, LLMS_TXT_SITE_URL), {
			headers: {
				"Content-Type": "text/markdown; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		});
	} catch (error) {
		console.error(JSON.stringify({
			message: "blog discovery unavailable",
			surface: "llms.txt",
			error: error instanceof Error ? error.message : String(error),
		}));
		return new Response("Blog discovery is temporarily unavailable.\n", {
			status: 503,
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
			},
		});
	}
}
