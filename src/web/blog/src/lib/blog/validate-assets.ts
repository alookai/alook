import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { extname, join } from "path";

export type BlogAssetError = string;

export type BlogAssetFs = {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf-8") => string;
  readdirSync: (path: string) => string[];
  fileSize?: (path: string) => number;
};

const defaultFs: BlogAssetFs = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path) => readdirSync(path) as string[],
  fileSize: (path) => statSync(path).size,
};

const REQUIRED_METADATA_FIELDS = [
  "slug",
  "title",
  "date",
  "author",
  "excerpt",
  "readingTime",
] as const;
const OPTIONAL_METADATA_FIELDS = ["dateModified", "image"] as const;
const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export type BlogMetadata = Record<string, string>;

function extractMetadataObject(content: string): string | null {
  const declaration = /export\s+const\s+metadata\s*=\s*\{/.exec(content);
  if (!declaration) return null;

  const start = content.indexOf("{", declaration.index);
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(start + 1, index);
    }
  }
  return null;
}

function readStringProperty(object: string, property: string): string | null {
  const match = new RegExp(`(?:^|[,\\n])\\s*${property}\\s*:\\s*(["'])`).exec(object);
  if (!match) return null;

  const quote = match[1];
  let value = "";
  let escaped = false;
  for (let index = match.index + match[0].length; index < object.length; index += 1) {
    const char = object[index];
    if (escaped) {
      value += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === quote) {
      return value;
    } else {
      value += char;
    }
  }
  return null;
}

export function isDraftBlogPost(content: string): boolean {
  const object = extractMetadataObject(content);
  if (!object) return false;
  return new RegExp(`(?:^|[,\\n])\\s*draft\\s*:\\s*true(?:\\s*[,\\n]|\\s*$)`).test(
    object
  );
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function readBlogMetadata(
  content: string,
  fileSlug: string
): { metadata: BlogMetadata; errors: BlogAssetError[] } {
  const object = extractMetadataObject(content);
  if (!object) {
    return {
      metadata: {},
      errors: [`[post: ${fileSlug}] Missing or unterminated export const metadata object.`],
    };
  }

  const metadata: BlogMetadata = {};
  const errors: BlogAssetError[] = [];
  for (const field of [...REQUIRED_METADATA_FIELDS, ...OPTIONAL_METADATA_FIELDS]) {
    const value = readStringProperty(object, field);
    if (value !== null) metadata[field] = value;
  }

  for (const field of REQUIRED_METADATA_FIELDS) {
    if (!metadata[field]?.trim()) {
      errors.push(`[post: ${fileSlug}] Missing or empty metadata field "${field}".`);
    }
  }
  if (metadata.slug && metadata.slug !== fileSlug) {
    errors.push(
      `[post: ${fileSlug}] Metadata slug "${metadata.slug}" must match filename "${fileSlug}.mdx".`
    );
  }
  if (metadata.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.slug)) {
    errors.push(`[post: ${fileSlug}] Metadata slug must use lowercase kebab-case.`);
  }
  for (const field of ["date", "dateModified"] as const) {
    if (metadata[field] && !isIsoDate(metadata[field])) {
      errors.push(`[post: ${fileSlug}] Metadata field "${field}" must be a valid YYYY-MM-DD date.`);
    }
  }
  if (
    metadata.date &&
    metadata.dateModified &&
    isIsoDate(metadata.date) &&
    isIsoDate(metadata.dateModified) &&
    metadata.dateModified < metadata.date
  ) {
    errors.push(`[post: ${fileSlug}] Metadata dateModified cannot be earlier than date.`);
  }
  if (metadata.readingTime && !/^[1-9]\d* min read$/.test(metadata.readingTime)) {
    errors.push(`[post: ${fileSlug}] Metadata readingTime must use "N min read".`);
  }

  return { metadata, errors };
}

export function findDuplicateMdxH1Errors(
  content: string,
  slug: string
): BlogAssetError[] {
  const errors: BlogAssetError[] = [];
  const h1Lines = content
    .split("\n")
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => /^# (?!#)/.test(line));
  for (const { line, index } of h1Lines) {
    errors.push(
      `[post: ${slug}] Duplicate H1 at line ${index}: "${line}". Remove MDX "# Title" — the page template owns the single H1.`
    );
  }
  return errors;
}

function findImageSourceErrors(
  sources: string[],
  slug: string,
  publicDir: string,
  fileExists: (path: string) => boolean,
  fileSize?: (path: string) => number
): BlogAssetError[] {
  const errors: BlogAssetError[] = [];
  for (const src of new Set(sources)) {
    if (!src.startsWith(`/blog/${slug}/`)) {
      errors.push(
        `[post: ${slug}] Image src "${src}" must start with /blog/${slug}/ — move the file to the post's public/blog directory.`
      );
      continue;
    }
    const extension = extname(src).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
      errors.push(
        `[post: ${slug}] Image src "${src}" must use jpg, jpeg, png, svg, or webp.`
      );
      continue;
    }
    const filePath = join(publicDir, src);
    if (!fileExists(filePath)) {
      errors.push(`[post: ${slug}] Image file not found: public${src}`);
      continue;
    }
    if (fileSize && fileSize(filePath) > MAX_IMAGE_BYTES) {
      errors.push(`[post: ${slug}] Image file exceeds 2 MiB: public${src}`);
    }
  }
  return errors;
}

export function findBlogImageErrors(
  content: string,
  slug: string,
  publicDir: string,
  fileExists: (path: string) => boolean = existsSync,
  metadataImage?: string,
  fileSize?: (path: string) => number
): BlogAssetError[] {
  const sources = metadataImage ? [metadataImage] : [];
  const imgRegex = /!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)|<img[^>]+src=["']([^"']*)["'][^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(content)) !== null) {
    sources.push(match[1] || match[2]);
  }
  return findImageSourceErrors(sources, slug, publicDir, fileExists, fileSize);
}

export function collectBlogAssetErrors(
  content: string,
  slug: string,
  publicDir: string,
  fileExists: (path: string) => boolean = existsSync,
  metadataImage?: string,
  fileSize?: (path: string) => number
): BlogAssetError[] {
  return [
    ...findDuplicateMdxH1Errors(content, slug),
    ...findBlogImageErrors(content, slug, publicDir, fileExists, metadataImage, fileSize),
  ];
}

export type ValidateBlogAssetsResult =
  | { status: "skipped" }
  | { status: "ok" }
  | { status: "failed"; errors: BlogAssetError[] };

export function validateBlogAssets(
  contentDir: string,
  publicDir: string,
  fs: BlogAssetFs = defaultFs
): ValidateBlogAssetsResult {
  if (!fs.existsSync(contentDir)) {
    return { status: "skipped" };
  }

  const errors: BlogAssetError[] = [];
  const seenSlugs = new Map<string, string>();
  const mdxFiles = fs.readdirSync(contentDir).filter((file) => file.endsWith(".mdx"));

  for (const file of mdxFiles) {
    const fileSlug = file.replace(/\.mdx$/, "");
    const content = fs.readFileSync(join(contentDir, file), "utf-8");
    const { metadata, errors: metadataErrors } = readBlogMetadata(content, fileSlug);
    errors.push(...metadataErrors);
    if (metadata.slug) {
      const previousFile = seenSlugs.get(metadata.slug);
      if (previousFile) {
        errors.push(
          `[post: ${fileSlug}] Duplicate metadata slug "${metadata.slug}" also used by ${previousFile}.`
        );
      } else {
        seenSlugs.set(metadata.slug, file);
      }
    }
    errors.push(
      ...collectBlogAssetErrors(
        content,
        fileSlug,
        publicDir,
        fs.existsSync,
        metadata.image,
        fs.fileSize
      )
    );
  }

  if (errors.length > 0) {
    return { status: "failed", errors };
  }
  return { status: "ok" };
}

export type ValidateBlogAssetsIo = {
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
};

export function runValidateBlogAssetsCli(
  contentDir: string,
  publicDir: string,
  io: ValidateBlogAssetsIo,
  fs: BlogAssetFs = defaultFs
): void {
  const result = validateBlogAssets(contentDir, publicDir, fs);

  if (result.status === "skipped") {
    io.log("✓ Blog validation skipped (no content directory).");
    io.exit(0);
    return;
  }

  if (result.status === "failed") {
    io.error("Blog validation failed:\n");
    for (const err of result.errors) {
      io.error(`  ✗ ${err}`);
    }
    io.error(`\n${result.errors.length} error(s) found.`);
    io.exit(1);
    return;
  }

  io.log("✓ Blog validation passed.");
  io.exit(0);
}
