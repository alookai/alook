import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { BlogPost } from "../types";
import { importMdxMetadata } from "./import-mdx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentDir = join(__dirname, "..", "..", "..", "content");

const REQUIRED_FIELDS: (keyof BlogPost)[] = [
  "slug",
  "title",
  "date",
  "author",
  "excerpt",
  "readingTime",
];

function validateMetadata(
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

let cachedPosts: BlogPost[] | null = null;

export type { BlogPost } from "../types";

export async function getAllPosts(): Promise<BlogPost[]> {
  if (cachedPosts) {
    return [...cachedPosts].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }

  const files = readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));
  const posts: BlogPost[] = [];

  for (const file of files) {
    const slug = file.replace(/\.mdx$/, "");
    const metadata = await importMdxMetadata(slug);

    if (
      !metadata ||
      !validateMetadata(metadata as Record<string, unknown>, file)
    )
      continue;
    if (metadata.draft) continue;

    posts.push(metadata);
  }

  cachedPosts = posts;

  return [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
}

export async function getPostBySlug(
  slug: string
): Promise<BlogPost | undefined> {
  const posts = await getAllPosts();
  return posts.find((p) => p.slug === slug);
}
