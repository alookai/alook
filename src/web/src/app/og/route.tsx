import { BRAND_SLOGAN } from "@/lib/brand-copy";
import { renderOgImage } from "@/app/_og/render-og-image";

/**
 * Fixed compatibility image for metadata inherited from the root layout.
 * Query parameters are intentionally ignored; route-owned image files provide
 * every page-specific title.
 */
export async function GET() {
  try {
    return await renderOgImage(BRAND_SLOGAN);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`OG generation failed: ${message}`, { status: 500 });
  }
}
