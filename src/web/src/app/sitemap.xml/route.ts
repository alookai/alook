import { getBlogDiscoveryManifest } from "@/lib/blog-worker-client";
import { buildRootSitemap, serializeRootSitemap } from "@/lib/root-sitemap";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		const manifest = await getBlogDiscoveryManifest();
		return new Response(serializeRootSitemap(buildRootSitemap(manifest)), {
			headers: {
				"Content-Type": "application/xml; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		});
	} catch (error) {
		console.error(JSON.stringify({
			message: "blog discovery unavailable",
			surface: "sitemap.xml",
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
