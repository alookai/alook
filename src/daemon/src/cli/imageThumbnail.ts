import {
  MAX_ATTACHMENT_THUMBNAIL_EDGE_PX,
  MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES,
} from "@alook/shared/constants/community";

const RASTER_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const QUALITIES = [80, 70, 60, 50, 40, 30, 20];
const DIMENSION_ATTEMPTS = 10;
const DIMENSION_SCALE = 0.85;

export type CommunityImageUploadPreparation = {
  thumbnail?: Uint8Array;
  width?: number;
  height?: number;
};

export async function prepareCommunityImageUpload(
  bytes: Uint8Array,
  contentType: string,
): Promise<CommunityImageUploadPreparation> {
  if (!RASTER_CONTENT_TYPES.has(contentType)) return {};

  let required = bytes.byteLength > MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES;
  try {
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height) {
      if (required) throw new Error("missing image dimensions");
      return {};
    }

    required = required || Math.max(width, height) > MAX_ATTACHMENT_THUMBNAIL_EDGE_PX;
    if (!required) return { width, height };

    const fittedScale = Math.min(
      1,
      MAX_ATTACHMENT_THUMBNAIL_EDGE_PX / Math.max(width, height),
    );
    const fittedWidth = Math.max(1, Math.round(width * fittedScale));
    const fittedHeight = Math.max(1, Math.round(height * fittedScale));

    for (let attempt = 0; attempt < DIMENSION_ATTEMPTS; attempt++) {
      const scale = DIMENSION_SCALE ** attempt;
      const targetWidth = Math.max(1, Math.round(fittedWidth * scale));
      const targetHeight = Math.max(1, Math.round(fittedHeight * scale));
      for (const quality of QUALITIES) {
        const jpeg = await sharp(bytes, { failOn: "error" })
          .resize({
            width: targetWidth,
            height: targetHeight,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality })
          .toBuffer();
        if (jpeg.byteLength <= MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES) {
          return { thumbnail: new Uint8Array(jpeg), width, height };
        }
      }
    }
    throw new Error("no policy-compliant JPEG candidate");
  } catch {
    if (required) {
      throw new Error("could not generate a required image preview");
    }
    return {};
  }
}
