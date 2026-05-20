import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentDir = join(__dirname, "..", "src", "content");
const publicDir = join(__dirname, "..", "public");

const errors: string[] = [];

const mdxFiles = readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));

for (const file of mdxFiles) {
  const slug = file.replace(/\.mdx$/, "");
  const content = readFileSync(join(contentDir, file), "utf-8");

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
    if (!existsSync(filePath)) {
      errors.push(`[post: ${slug}] Image file not found: public${src}`);
    }
  }
}

if (errors.length > 0) {
  console.error("Blog asset validation failed:\n");
  for (const err of errors) {
    console.error(`  ✗ ${err}`);
  }
  console.error(`\n${errors.length} error(s) found.`);
  process.exit(1);
}

console.log("✓ Blog asset validation passed.");
