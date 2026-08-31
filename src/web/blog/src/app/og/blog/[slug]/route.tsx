import { renderOgImage } from "@/app/_og/render-og-image";
import { getPostBySlug } from "@blog/lib/blog/posts/get-post-by-slug";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) return new Response("Not Found", { status: 404 });

  return renderOgImage(post.title);
}
