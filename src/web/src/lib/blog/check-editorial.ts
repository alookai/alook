import { readFileSync, readdirSync } from "fs";
import { join } from "path";

export type EditorialSeverity = "fail" | "warn";

export type EditorialFinding = {
  severity: EditorialSeverity;
  slug?: string;
  rule: string;
  message: string;
};

export const PRODUCT_BOILERPLATE =
  "Alook currently supports Claude Code, Codex, and OpenCode. Cursor, Hermes, and OpenClaw are listed as coming soon.";

export const PRODUCT_BOILERPLATE_PREFIX = "Alook currently supports Claude Code, Codex, and OpenCode";

export const CANONICAL_PRODUCT_SLUG = "ai-agent-team";

export const HIGH_RECOGNITION_PHRASES = [
  "shared context",
  "the bottleneck",
  "you become the router",
  "you become the message bus",
  "human middleware",
  "start with one workflow",
  "the trouble starts",
  "the value comes from",
] as const;

const SENTENCE_START_BANS = [
  /^Additionally\b/i,
  /^Furthermore\b/i,
  /^Moreover\b/i,
  /^In essence\b/i,
  /^Essentially\b/i,
  /^At its core\b/i,
  /^It's worth noting\b/i,
];

const PHRASE_BANS = [
  /\bLet's dive in\b/i,
  /\bThe real question is\b/i,
  /\bIn conclusion\b/i,
];

const VAGUE_ATTRIBUTION = [
  /according to industry reports/i,
  /\bstudies show\b/i,
  /\bexperts argue\b/i,
];

const NOT_JUST_BUT = /\bnot just\b[^.!?]{0,120}\bbut\b/gi;

export type ParsedMdx = {
  slug: string;
  title: string;
  bodyProse: string;
  bodyLinks: string;
};

export function stripMdxForLinkCheck(content: string): string {
  let text = content;
  text = text.replace(/export const metadata\s*=\s*\{[\s\S]*?\};\s*/m, "");
  text = text.replace(/export const jsonLd\s*=\s*\[[\s\S]*?\];\s*/m, "");
  text = text.replace(/```[\s\S]*?```/g, "\n");
  return text;
}

export function stripMdxForProse(content: string): string {
  let text = stripMdxForLinkCheck(content);
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "\n");
  text = text.replace(/<img[^>]*>/gi, "\n");
  text = text.replace(/^#{1,6}\s+.*$/gm, "\n");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/\|/g, " ");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function parseMdxFile(slug: string, content: string): ParsedMdx {
  const titleMatch = content.match(/title:\s*["']([^"']+)["']/);
  const title = titleMatch?.[1] ?? slug;
  const bodyLinks = stripMdxForLinkCheck(content);
  const bodyProse = stripMdxForProse(content);
  return { slug, title, bodyProse, bodyLinks };
}

export function countWords(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

export function firstNWords(text: string, n: number): string {
  return text.trim().split(/\s+/).slice(0, n).join(" ");
}

export function splitParagraphs(prose: string): string[] {
  return prose
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0 && !/^export\b/.test(p));
}

export function sentenceCount(paragraph: string): number {
  const parts = paragraph
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Math.max(parts.length, 1);
}

export function paragraphLengthStdev(paragraphs: string[]): number {
  if (paragraphs.length < 2) return 2;
  const counts = paragraphs.map((p) => sentenceCount(p));
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance =
    counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
  return Math.sqrt(variance);
}

export function countExternalLinks(content: string): number {
  const links = [...content.matchAll(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)].map(
    (m) => m[1]!
  );
  const bare = [...content.matchAll(/(?<!\])\((https?:\/\/[^)]+)\)/g)].map(
    (m) => m[1]!
  );
  const all = [...links, ...bare];
  const thirdParty = all.filter((url) => {
    const lower = url.toLowerCase();
    return (
      !lower.includes("alook.ai") &&
      !lower.includes("github.com/alookai")
    );
  });
  return new Set(thirdParty).size;
}

function checkPerPost(parsed: ParsedMdx): EditorialFinding[] {
  const findings: EditorialFinding[] = [];
  const { slug, title, bodyProse, bodyLinks } = parsed;

  if (title.length > 60) {
    findings.push({
      severity: "fail",
      slug,
      rule: "title-length",
      message: `Title is ${title.length} chars (max 60): "${title}"`,
    });
  }

  const opening = firstNWords(bodyLinks, 100).toLowerCase();
  if (opening.includes("alook.ai") || opening.includes("npx @alook/app onboard")) {
    findings.push({
      severity: "fail",
      slug,
      rule: "opening-alook",
      message: "First 100 words contain alook.ai or onboard CTA",
    });
  }

  const externalLinks = countExternalLinks(bodyLinks);
  if (externalLinks < 2) {
    findings.push({
      severity: "fail",
      slug,
      rule: "external-links",
      message: `Only ${externalLinks} third-party link(s) in body (need ≥2)`,
    });
  }

  for (const pattern of VAGUE_ATTRIBUTION) {
    if (pattern.test(bodyProse)) {
      findings.push({
        severity: "fail",
        slug,
        rule: "vague-attribution",
        message: `Vague attribution matched: ${pattern}`,
      });
    }
  }

  for (const line of bodyProse.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const pattern of SENTENCE_START_BANS) {
      if (pattern.test(trimmed)) {
        findings.push({
          severity: "fail",
          slug,
          rule: "ai-sentence-start",
          message: `Banned sentence start: "${trimmed.slice(0, 60)}..."`,
        });
      }
    }
  }

  const paragraphs = splitParagraphs(bodyProse);
  const stdev = paragraphLengthStdev(paragraphs);
  if (paragraphs.length >= 3 && stdev <= 1.5) {
    findings.push({
      severity: "warn",
      slug,
      rule: "paragraph-stdev",
      message: `Paragraph sentence-count stdev is ${stdev.toFixed(2)} (target > 1.5)`,
    });
  }

  for (let i = 0; i + 2 < paragraphs.length; i++) {
    const a = sentenceCount(paragraphs[i]!);
    const b = sentenceCount(paragraphs[i + 1]!);
    const c = sentenceCount(paragraphs[i + 2]!);
    if (a === b && b === c) {
      findings.push({
        severity: "warn",
        slug,
        rule: "paragraph-rhythm",
        message: `Three consecutive paragraphs with ${a} sentence(s) each (around paragraph ${i + 1})`,
      });
      break;
    }
  }

  for (const pattern of PHRASE_BANS) {
    if (pattern.test(bodyProse)) {
      findings.push({
        severity: "warn",
        slug,
        rule: "ai-phrase",
        message: `Template phrase matched: ${pattern}`,
      });
    }
  }

  const notJustMatches = bodyProse.match(NOT_JUST_BUT) ?? [];
  if (notJustMatches.length > 2) {
    findings.push({
      severity: "warn",
      slug,
      rule: "not-just-but",
      message: `"Not just X but Y" appears ${notJustMatches.length} times (max 2)`,
    });
  }

  if (
    bodyProse.includes(PRODUCT_BOILERPLATE) &&
    slug !== CANONICAL_PRODUCT_SLUG
  ) {
    findings.push({
      severity: "warn",
      slug,
      rule: "product-boilerplate-body",
      message:
        "Full product capability sentence in body — link to /blog/ai-agent-team instead",
    });
  }

  return findings;
}

function checkCorpus(all: ParsedMdx[]): EditorialFinding[] {
  const findings: EditorialFinding[] = [];

  const boilerplatePosts = all.filter((p) =>
    p.bodyProse.includes(PRODUCT_BOILERPLATE)
  );
  if (boilerplatePosts.length > 1) {
    findings.push({
      severity: "warn",
      rule: "corpus-product-boilerplate",
      message: `Full product sentence in body of ${boilerplatePosts.length} posts: ${boilerplatePosts.map((p) => p.slug).join(", ")} (max 1; canonical: ${CANONICAL_PRODUCT_SLUG})`,
    });
  }

  for (const phrase of HIGH_RECOGNITION_PHRASES) {
    const hits = all.filter((p) =>
      p.bodyProse.toLowerCase().includes(phrase.toLowerCase())
    );
    if (hits.length > 1) {
      findings.push({
        severity: "warn",
        rule: "corpus-phrase",
        message: `"${phrase}" in ${hits.length} posts: ${hits.map((p) => p.slug).join(", ")}`,
      });
    }
  }

  return findings;
}

export function checkBlogEditorial(
  posts: ParsedMdx[]
): EditorialFinding[] {
  const perPost = posts.flatMap((p) => checkPerPost(p));
  const corpus = checkCorpus(posts);
  return [...perPost, ...corpus];
}

export function loadBlogPostsFromDir(contentDir: string): ParsedMdx[] {
  const files = readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));
  return files.map((file) => {
    const slug = file.replace(/\.mdx$/, "");
    const content = readFileSync(join(contentDir, file), "utf-8");
    return parseMdxFile(slug, content);
  });
}

export type EditorialCheckIo = {
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
};

export function formatEditorialReport(findings: EditorialFinding[]): string {
  const fails = findings.filter((f) => f.severity === "fail");
  const warns = findings.filter((f) => f.severity === "warn");
  const lines: string[] = [];
  if (fails.length === 0 && warns.length === 0) {
    return "✓ Blog editorial check passed.";
  }
  for (const f of fails) {
    const prefix = f.slug ? `[${f.slug}]` : "[corpus]";
    lines.push(`FAIL ${prefix} ${f.rule}: ${f.message}`);
  }
  for (const f of warns) {
    const prefix = f.slug ? `[${f.slug}]` : "[corpus]";
    lines.push(`WARN ${prefix} ${f.rule}: ${f.message}`);
  }
  lines.push("");
  lines.push(`Summary: ${fails.length} fail(s), ${warns.length} warn(s)`);
  return lines.join("\n");
}

export function runCheckBlogEditorialCli(
  contentDir: string,
  io: EditorialCheckIo,
  options: { strict?: boolean; reportOnly?: boolean } = {}
): void {
  const posts = loadBlogPostsFromDir(contentDir);
  const findings = checkBlogEditorial(posts);
  const fails = findings.filter((f) => f.severity === "fail");
  const warns = findings.filter((f) => f.severity === "warn");

  io.log(formatEditorialReport(findings));

  if (options.reportOnly) {
    io.exit(0);
    return;
  }

  if (fails.length > 0) {
    io.exit(1);
    return;
  }

  if (options.strict && warns.length > 0) {
    io.exit(1);
    return;
  }

  io.exit(0);
}
