import type { BlogPost } from "../types";

export async function importMdxMetadata(
  slug: string
): Promise<BlogPost | undefined> {
  const mod = await import(`@/content/${slug}.mdx`);
  return mod.metadata;
}
