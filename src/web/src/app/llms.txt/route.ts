import { getAllPosts } from "@/lib/blog/posts";
import { buildLlmsTxt, LLMS_TXT_SITE_URL } from "@/lib/blog/llms-txt";

export async function GET() {
  const posts = await getAllPosts();
  const body = buildLlmsTxt(posts, LLMS_TXT_SITE_URL);

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
