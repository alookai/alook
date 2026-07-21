export function GET() {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /w/",
    "Disallow: /workspaces",
    "Disallow: /api/",
    "",
    "Sitemap: https://alook.ai/sitemap.xml",
    "",
    "# Agent discovery map (https://llmstxt.org/)",
    "# https://alook.ai/llms.txt",
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
