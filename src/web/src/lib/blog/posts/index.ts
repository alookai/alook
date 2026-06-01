import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { BlogPost } from "../types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentDir = join(__dirname, "..", "..", "..", "content");

function extractMetadata(filePath: string): BlogPost | null {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(
    /export\s+const\s+metadata\s*=\s*(\{[\s\S]*?\n\});/
  );
  if (!match) return null;
  try {
    return new Function(`return ${match[1]}`)() as BlogPost;
  } catch {
    return null;
  }
}

function scanPosts(): BlogPost[] {
  const files = readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));
  const posts: BlogPost[] = [];

  for (const file of files) {
    const metadata = extractMetadata(join(contentDir, file));
    if (metadata && !metadata.draft) {
      posts.push(metadata);
    }
  }

  return posts;
}

let cachedPosts: BlogPost[] | null = null;

function getPosts(): BlogPost[] {
  if (!cachedPosts) {
    cachedPosts = scanPosts();
  }
  return cachedPosts;
}

export type { BlogPost } from "../types";

export function getAllPosts(): BlogPost[] {
  return [...getPosts()].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
}

export function getPostBySlug(slug: string): BlogPost | undefined {
  return getPosts().find((p) => p.slug === slug);
}
