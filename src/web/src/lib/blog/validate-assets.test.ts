import { describe, expect, it } from "vitest";
import { join } from "path";
import {
  collectBlogAssetErrors,
  findBlogImageErrors,
  findDuplicateMdxH1Errors,
  runValidateBlogAssetsCli,
  validateBlogAssets,
  type BlogAssetFs,
} from "./validate-assets";

/** Normalize path separators so mocks work on Windows and Unix. */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

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
      '[post: demo] Image src "/images/hero.png" must start with /blog/ — move the file to public/blog/',
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
      readFileSync: () => "![alt](/blog/demo/hero.webp)\n\n## Section\n",
      readdirSync: () => ["demo.mdx", "readme.txt"],
    };
    expect(validateBlogAssets("/content", "/public", fs)).toEqual({
      status: "ok",
    });
  });

  it("returns failed with duplicate H1 errors", () => {
    const fs: BlogAssetFs = {
      existsSync: (path) => norm(path) === "/content",
      readFileSync: () => "# Title\n\nBody\n",
      readdirSync: () => ["demo.mdx"],
    };
    const result = validateBlogAssets("/content", "/public", fs);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errors[0]).toContain("Duplicate H1");
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
      readFileSync: () => "![alt](/blog/demo/hero.webp)\n",
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
      readFileSync: () => "# Title\n",
      readdirSync: () => ["demo.mdx"],
    };
    runValidateBlogAssetsCli("/content", "/public", io, fs);
    expect(errors.some((line) => line.includes("Duplicate H1"))).toBe(true);
    expect(exits).toEqual([1]);
  });
});
