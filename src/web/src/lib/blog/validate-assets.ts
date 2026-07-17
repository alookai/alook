import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

export type BlogAssetError = string;

export type BlogAssetFs = {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf-8") => string;
  readdirSync: (path: string) => string[];
};

const defaultFs: BlogAssetFs = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path) => readdirSync(path) as string[],
};

/** Markdown ATX `# Title` lines (not ## / ###). Page shell already owns the H1. */
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

export function findBlogImageErrors(
  content: string,
  slug: string,
  publicDir: string,
  fileExists: (path: string) => boolean = existsSync
): BlogAssetError[] {
  const errors: BlogAssetError[] = [];
  const imgRegex = /!\[[^\]]*\]\(([^)]*)\)|<img[^>]+src="([^"]*)"[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = imgRegex.exec(content)) !== null) {
    const src = match[1] || match[2];

    if (!src.startsWith("/blog/")) {
      errors.push(
        `[post: ${slug}] Image src "${src}" must start with /blog/ — move the file to public/blog/`
      );
      continue;
    }

    const filePath = join(publicDir, src);
    if (!fileExists(filePath)) {
      errors.push(`[post: ${slug}] Image file not found: public${src}`);
    }
  }
  return errors;
}

export function collectBlogAssetErrors(
  content: string,
  slug: string,
  publicDir: string,
  fileExists: (path: string) => boolean = existsSync
): BlogAssetError[] {
  return [
    ...findDuplicateMdxH1Errors(content, slug),
    ...findBlogImageErrors(content, slug, publicDir, fileExists),
  ];
}

export type ValidateBlogAssetsResult =
  | { status: "skipped" }
  | { status: "ok" }
  | { status: "failed"; errors: BlogAssetError[] };

/** Validate all MDX posts under contentDir against publicDir image files. */
export function validateBlogAssets(
  contentDir: string,
  publicDir: string,
  fs: BlogAssetFs = defaultFs
): ValidateBlogAssetsResult {
  if (!fs.existsSync(contentDir)) {
    return { status: "skipped" };
  }

  const errors: BlogAssetError[] = [];
  const mdxFiles = fs.readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));

  for (const file of mdxFiles) {
    const slug = file.replace(/\.mdx$/, "");
    const content = fs.readFileSync(join(contentDir, file), "utf-8");
    errors.push(
      ...collectBlogAssetErrors(content, slug, publicDir, fs.existsSync)
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

/** CLI entry used by scripts/validate-blog-assets.ts */
export function runValidateBlogAssetsCli(
  contentDir: string,
  publicDir: string,
  io: ValidateBlogAssetsIo,
  fs: BlogAssetFs = defaultFs
): void {
  const result = validateBlogAssets(contentDir, publicDir, fs);

  if (result.status === "skipped") {
    io.log("✓ Blog asset validation skipped (no content directory).");
    io.exit(0);
    return;
  }

  if (result.status === "failed") {
    io.error("Blog asset validation failed:\n");
    for (const err of result.errors) {
      io.error(`  ✗ ${err}`);
    }
    io.error(`\n${result.errors.length} error(s) found.`);
    io.exit(1);
    return;
  }

  io.log("✓ Blog asset validation passed.");
  io.exit(0);
}
