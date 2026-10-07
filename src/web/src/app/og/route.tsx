import { SITE_OG_IMAGE_URL } from "@/lib/seo/site-metadata";

/**
 * Legacy brand-image URL; page-specific images retain their own routes.
 * Query parameters cannot change the shared brand card.
 */
export function GET(request: Request) {
  return Response.redirect(new URL(SITE_OG_IMAGE_URL, request.url), 308);
}
