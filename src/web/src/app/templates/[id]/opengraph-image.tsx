import {
  OG_IMAGE_CONTENT_TYPE,
  OG_IMAGE_SIZE,
  renderOgImage,
} from "@/app/_og/render-og-image";
import { getTemplateById } from "@/lib/templates";

export const alt = "Alook AI company template";
export const size = OG_IMAGE_SIZE;
export const contentType = OG_IMAGE_CONTENT_TYPE;

export default async function OpenGraphImage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const template = getTemplateById(id);
  return renderOgImage(template?.name ?? "AI Company Templates");
}
