import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type BlogHeading = {
  id: string;
  text: string;
};

const NON_SLUG_CHARS = /[^\p{L}\p{N}\p{M} _-]/gu;

function stripInlineMarkdown(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1")
    .trim();
}

export function slugifyHeading(
  text: string,
  occurrences: Record<string, number> = Object.create(null),
): string {
  const base = text
    .toLowerCase()
    .replace(NON_SLUG_CHARS, "")
    .replace(/ /g, "-");
  let candidate = base;
  while (Object.prototype.hasOwnProperty.call(occurrences, candidate)) {
    occurrences[base] = (occurrences[base] ?? 0) + 1;
    candidate = `${base}-${occurrences[base]}`;
  }
  occurrences[candidate] = 0;
  return candidate;
}

export function extractBlogHeadings(source: string): BlogHeading[] {
  const occurrences: Record<string, number> = Object.create(null);
  const headings: BlogHeading[] = [];
  let activeFence: string | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (!activeFence) {
        activeFence = marker;
      } else if (activeFence === marker) {
        activeFence = null;
      }
      continue;
    }
    if (activeFence) continue;

    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!headingMatch) continue;
    const level = headingMatch[1].length;
    const text = stripInlineMarkdown(headingMatch[2]);
    if (!text) continue;
    const id = slugifyHeading(text, occurrences);
    if (level === 2 && id) {
      headings.push({ id, text });
    }
  }

  return headings;
}

function resolveContentDir(): string | null {
  const candidates: string[] = [
    path.resolve(process.cwd(), "src/content"),
    path.resolve(process.cwd(), "blog/src/content"),
  ];
  if (typeof import.meta.dirname === "string") {
    candidates.unshift(path.resolve(import.meta.dirname, "../../content"));
  }
  for (const dir of candidates) {
    if (existsSync(/*turbopackIgnore: true*/ dir)) return dir;
  }
  return null;
}

export function getBlogHeadingsBySlug(slug: string): BlogHeading[] {
  try {
    const contentDir = resolveContentDir();
    if (!contentDir) return [];
    const filePath = path.join(contentDir, `${slug}.mdx`);
    const source = readFileSync(/*turbopackIgnore: true*/ filePath, "utf8");
    return extractBlogHeadings(source);
  } catch {
    return [];
  }
}
