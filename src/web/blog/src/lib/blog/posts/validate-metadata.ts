import type { BlogPost } from "../types";

const REQUIRED_FIELDS: (keyof BlogPost)[] = [
  "slug",
  "title",
  "date",
  "author",
  "excerpt",
  "readingTime",
];

export function validateMetadata(
  metadata: Record<string, unknown>,
  file: string
): metadata is BlogPost {
  for (const field of REQUIRED_FIELDS) {
    if (!metadata[field]) {
      console.warn(
        `[blog] Skipping ${file}: missing required field "${field}"`
      );
      return false;
    }
  }
  return true;
}
