import { createBlogDiscoveryManifest } from "@/lib/blog-discovery-manifest";
import { getAllPosts } from "@blog/lib/blog/posts";

export const dynamic = "force-static";

export async function GET() {
	const posts = await getAllPosts();
	return Response.json(createBlogDiscoveryManifest(posts));
}
