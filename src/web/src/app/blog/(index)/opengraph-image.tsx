import {
  OG_IMAGE_CONTENT_TYPE,
  OG_IMAGE_SIZE,
  renderOgImage,
} from "@/app/_og/render-og-image";

export const alt = "Multi-Agent Collaboration & AI Team — Alook";
export const size = OG_IMAGE_SIZE;
export const contentType = OG_IMAGE_CONTENT_TYPE;

export default function OpenGraphImage() {
  return renderOgImage("Multi-Agent Collaboration & AI Team");
}
