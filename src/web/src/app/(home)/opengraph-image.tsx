import { BRAND_SLOGAN, BRAND_TITLE } from "@/lib/brand-copy";
import {
  OG_IMAGE_CONTENT_TYPE,
  OG_IMAGE_SIZE,
  renderOgImage,
} from "@/app/_og/render-og-image";

export const alt = BRAND_TITLE;
export const size = OG_IMAGE_SIZE;
export const contentType = OG_IMAGE_CONTENT_TYPE;

export default function OpenGraphImage() {
  return renderOgImage(BRAND_SLOGAN);
}
