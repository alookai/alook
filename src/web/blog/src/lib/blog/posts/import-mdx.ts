import type { BlogPost } from "../types";

export function isMissingMdxMetadataModule(error: unknown, slug: string): boolean {
  if (!(error instanceof Error)) return false;
  const expectedFile = `${slug}.mdx`;
  if (
    error.message.startsWith("Unknown variable dynamic import: ") &&
    error.message.endsWith(`/${expectedFile}`)
  ) {
    return true;
  }

  const code = "code" in error ? String(error.code) : "";
  if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") return false;
  const missingSpecifier = error.message.match(/^Cannot find module ['"]([^'"]+)['"]/)?.[1];
  return missingSpecifier === expectedFile || missingSpecifier?.endsWith(`/${expectedFile}`) === true;
}

export async function importMdxMetadata(
  slug: string
): Promise<BlogPost | undefined> {
  try {
    const mod = await import(`@blog/content/${slug}.mdx`);
    return mod.metadata;
  } catch (error) {
    if (isMissingMdxMetadataModule(error, slug)) return undefined;
    throw error;
  }
}
