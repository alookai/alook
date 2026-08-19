import { describe, expect, it } from "vitest";
import { join } from "path";
import {
  collectBlogAssetErrors,
  findBlogImageErrors,
  findDuplicateMdxH1Errors,
  isDraftBlogPost,
  readBlogMetadata,
  runValidateBlogAssetsCli,
  validateBlogAssets,
  type BlogAssetFs,
} from "./validate-assets";

/** Normalize path separators so mocks work on Windows and Unix. */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

function post(slug = "demo", body = "## Section"): string {
  return `export const metadata = {
  slug: "${slug}",
  title: "Demo",
  date: "2026-08-11",
  author: "Alook Team",
  excerpt: "Demo excerpt",
  readingTime: "2 min read",
};

${body}
`;
}

describe("readBlogMetadata", () => {
  it("reads required metadata and accepts valid dates", () => {
    expect(readBlogMetadata(post(), "demo")).toEqual({
      metadata: {
        slug: "demo",
        title: "Demo",
        date: "2026-08-11",
        author: "Alook Team",
        excerpt: "Demo excerpt",
        readingTime: "2 min read",
      },
      errors: [],
    });
  });

  it("rejects missing fields, invalid dates, and filename mismatches", () => {
    const content = `export const metadata = {
  slug: "other",
  title: "Demo",
  date: "2026-02-30",
  author: "Alook Team",
  excerpt: "Demo excerpt",
};`;
    const result = readBlogMetadata(content, "demo");

    expect(result.errors).toEqual(
      expect.arrayContaining([
        '[post: demo] Missing or empty metadata field "readingTime".',
        '[post: demo] Metadata slug "other" must match filename "demo.mdx".',
        '[post: demo] Metadata field "date" must be a valid YYYY-MM-DD date.',
      ])
    );
  });

  it("rejects backwards modified dates and invalid reading time", () => {
    const content = post()
      .replace('date: "2026-08-11",', 'date: "2026-08-11",\n  dateModified: "2026-08-10",')
      .replace('readingTime: "2 min read",', 'readingTime: "about two minutes",');
    const result = readBlogMetadata(content, "demo");

    expect(result.errors).toEqual([
      "[post: demo] Metadata dateModified cannot be earlier than date.",
      '[post: demo] Metadata readingTime must use "N min read".',
    ]);
  });

  it("rejects missing and unterminated metadata objects", () => {
    expect(readBlogMetadata("## Body", "demo").errors[0]).toContain("Missing or unterminated");
    expect(
      readBlogMetadata('export const metadata = { slug: "demo"', "demo").errors[0]
    ).toContain("Missing or unterminated");
  });
});

describe("isDraftBlogPost", () => {
  it("reads the draft flag only from the metadata object", () => {
    expect(
      isDraftBlogPost(post().replace('title: "Demo",', 'title: "Demo",\n  draft: true,'))
    ).toBe(true);
    expect(isDraftBlogPost(`${post()}\nDraft example: draft: true`)).toBe(false);
    expect(
      isDraftBlogPost(post().replace('title: "Demo",', 'title: "Demo",\n  draft: false,'))
    ).toBe(false);
  });
});

describe("findDuplicateMdxH1Errors", () => {
  it("flags markdown H1 lines with line numbers", () => {
    const content = ["export const metadata = {};", "", "# Hello Title", "", "Body"].join(
      "\n"
    );
    expect(findDuplicateMdxH1Errors(content, "demo")).toEqual([
      '[post: demo] Duplicate H1 at line 3: "# Hello Title". Remove MDX "# Title" — the page template owns the single H1.',
    ]);
  });

  it("ignores h2 and deeper headings", () => {
    const content = "## Section\n### Subsection\n";
    expect(findDuplicateMdxH1Errors(content, "demo")).toEqual([]);
  });
});

describe("findBlogImageErrors", () => {
  it("requires /blog/ image prefix", () => {
    const content = "![alt](/images/hero.png)\n";
    expect(findBlogImageErrors(content, "demo", "/public", () => true)).toEqual([
      '[post: demo] Image src "/images/hero.png" must start with /blog/demo/ — move the file to the post\'s public/blog directory.',
    ]);
  });

  it("flags missing files under public", () => {
    const content = "![alt](/blog/demo/hero.webp)\n";
    expect(findBlogImageErrors(content, "demo", "/public", () => false)).toEqual([
      "[post: demo] Image file not found: public/blog/demo/hero.webp",
    ]);
  });

  it("accepts existing /blog/ images", () => {
    const content = '![alt](/blog/demo/hero.webp)\n<img src="/blog/demo/b.png" />\n';
    expect(findBlogImageErrors(content, "demo", "/public", () => true)).toEqual([]);
  });

  it("validates metadata images, extensions, and file size", () => {
    expect(
      findBlogImageErrors("", "demo", "/public", () => true, "/blog/demo/hero.gif")
    ).toEqual([
      '[post: demo] Image src "/blog/demo/hero.gif" must use jpg, jpeg, png, svg, or webp.',
    ]);
    expect(
      findBlogImageErrors(
        "",
        "demo",
        "/public",
        () => true,
        "/blog/demo/hero.webp",
        () => 2 * 1024 * 1024 + 1
      )
    ).toEqual([
      "[post: demo] Image file exceeds 2 MiB: public/blog/demo/hero.webp",
    ]);
  });
});

describe("collectBlogAssetErrors", () => {
  it("combines H1 and image errors", () => {
    const content = "# Title\n\n![x](/bad.png)\n";
    expect(collectBlogAssetErrors(content, "demo", "/public", () => true)).toHaveLength(2);
  });
});

describe("validateBlogAssets", () => {
  it("skips when content directory is missing", () => {
    const fs: BlogAssetFs = {
      existsSync: () => false,
      readFileSync: () => "",
      readdirSync: () => [],
    };
    expect(validateBlogAssets("/missing", "/public", fs)).toEqual({
      status: "skipped",
    });
  });

  it("returns ok for clean MDX posts", () => {
    const heroPath = join("/public", "/blog/demo/hero.webp");
    const fs: BlogAssetFs = {
      existsSync: (path) =>
        norm(path) === "/content" || norm(path) === norm(heroPath),
      readFileSync: () => post("demo", "![alt](/blog/demo/hero.webp)\n\n## Section"),
      readdirSync: () => ["demo.mdx", "readme.txt"],
    };
    expect(validateBlogAssets("/content", "/public", fs)).toEqual({
      status: "ok",
    });
  });

  it("returns failed with duplicate H1 errors", () => {
    const fs: BlogAssetFs = {
      existsSync: (path) => norm(path) === "/content",
      readFileSync: () => post("demo", "# Title\n\nBody"),
      readdirSync: () => ["demo.mdx"],
    };
    const result = validateBlogAssets("/content", "/public", fs);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errors[0]).toContain("Duplicate H1");
    }
  });

  it("returns failed for duplicate metadata slugs", () => {
    const fs: BlogAssetFs = {
      existsSync: (path) => norm(path) === "/content",
      readFileSync: () => post("same"),
      readdirSync: () => ["one.mdx", "two.mdx"],
    };
    const result = validateBlogAssets("/content", "/public", fs);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errors.some((error) => error.includes("Duplicate metadata slug"))).toBe(true);
    }
  });
});

describe("runValidateBlogAssetsCli", () => {
  function mockIo() {
    const logs: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    return {
      logs,
      errors,
      exits,
      io: {
        log: (message: string) => logs.push(message),
        error: (message: string) => errors.push(message),
        exit: (code: number) => exits.push(code),
      },
    };
  }

  it("logs skip and exits 0 when content dir is missing", () => {
    const { io, logs, exits } = mockIo();
    const fs: BlogAssetFs = {
      existsSync: () => false,
      readFileSync: () => "",
      readdirSync: () => [],
    };
    runValidateBlogAssetsCli("/missing", "/public", io, fs);
    expect(logs[0]).toContain("skipped");
    expect(exits).toEqual([0]);
  });

  it("logs pass and exits 0 for clean posts", () => {
    const { io, logs, exits } = mockIo();
    const heroPath = join("/public", "/blog/demo/hero.webp");
    const fs: BlogAssetFs = {
      existsSync: (path) =>
        norm(path) === "/content" || norm(path) === norm(heroPath),
      readFileSync: () => post("demo", "![alt](/blog/demo/hero.webp)"),
      readdirSync: () => ["demo.mdx"],
    };
    runValidateBlogAssetsCli("/content", "/public", io, fs);
    expect(logs[0]).toContain("passed");
    expect(exits).toEqual([0]);
  });

  it("prints failures and exits 1 for duplicate H1", () => {
    const { io, errors, exits } = mockIo();
    const fs: BlogAssetFs = {
      existsSync: (path) => norm(path) === "/content",
      readFileSync: () => post("demo", "# Title"),
      readdirSync: () => ["demo.mdx"],
    };
    runValidateBlogAssetsCli("/content", "/public", io, fs);
    expect(errors.some((line) => line.includes("Duplicate H1"))).toBe(true);
    expect(exits).toEqual([1]);
  });
});
