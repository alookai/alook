import { getAllPosts } from "@/lib/blog/posts";

export function GET() {
  const posts = getAllPosts();
  const siteUrl = "https://alook.ai";

  const items = posts
    .map(
      (post) => `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${siteUrl}/blog/${post.slug}</link>
      <description>${escapeXml(post.excerpt)}</description>
      <pubDate>${new Date(post.date).toUTCString()}</pubDate>
      <guid isPermaLink="true">${siteUrl}/blog/${post.slug}</guid>
      <dc:creator>${escapeXml(post.author)}</dc:creator>
    </item>`
    )
    .join("");

  const lastBuildDate = posts.length > 0
    ? new Date(posts[0].date).toUTCString()
    : new Date().toUTCString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Alook Blog</title>
    <link>${siteUrl}/blog</link>
    <description>Thoughts on building AI companies, agent collaboration, and the future of personal software.</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <atom:link href="${siteUrl}/blog/feed.xml" rel="self" type="application/rss+xml" />${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml",
    },
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
