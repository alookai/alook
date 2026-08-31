import type { BlogPost } from "../types";
import { importMdxMetadata } from "./import-mdx";
import { validateMetadata } from "./validate-metadata";

export async function getPostBySlug(
  slug: string
): Promise<BlogPost | undefined> {
  const metadata = await importMdxMetadata(slug);
  if (
    !metadata ||
    !validateMetadata(metadata as Record<string, unknown>, `${slug}.mdx`) ||
    metadata.slug !== slug ||
    metadata.draft
  ) {
    return undefined;
  }
  return metadata;
}
