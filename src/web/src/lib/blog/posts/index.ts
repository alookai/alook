import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { BlogPost } from "../types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentDir = join(__dirname, "..", "..", "..", "content");

const REQUIRED_FIELDS = [
  "slug",
  "title",
  "date",
  "author",
  "excerpt",
  "readingTime",
] as const;

function extractStringField(block: string, field: string): string | undefined {
  const re = new RegExp(`${field}\\s*:\\s*\\n?\\s*(["'\`])`);
  const quoteMatch = block.match(re);
  if (!quoteMatch) return undefined;

  const quote = quoteMatch[1];
  const escaped = quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const valueRe = new RegExp(
    `${field}\\s*:\\s*\\n?\\s*${escaped}([^${escaped}]*)${escaped}`
  );
  const match = block.match(valueRe);
  return match ? match[1] : undefined;
}

function extractBooleanField(
  block: string,
  field: string
): boolean | undefined {
  const re = new RegExp(`${field}\\s*:\\s*(true|false)`);
  const match = block.match(re);
  return match ? match[1] === "true" : undefined;
}

function extractMetadata(filePath: string): BlogPost | null {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(
    /export\s+const\s+metadata\s*=\s*\{([\s\S]*?)\n\};/
  );
  if (!match) return null;

  const block = match[1];

  const slug = extractStringField(block, "slug");
  const title = extractStringField(block, "title");
  const date = extractStringField(block, "date");
  const author = extractStringField(block, "author");
  const excerpt = extractStringField(block, "excerpt");
  const readingTime = extractStringField(block, "readingTime");
  const draft = extractBooleanField(block, "draft");

  const parsed = { slug, title, date, author, excerpt, readingTime, draft };

  for (const field of REQUIRED_FIELDS) {
    if (!parsed[field]) {
      console.warn(
        `[blog] Skipping ${filePath}: missing required field "${field}"`
      );
      return null;
    }
  }

  return parsed as BlogPost;
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
