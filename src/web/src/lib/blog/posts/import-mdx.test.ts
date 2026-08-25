import { describe, expect, it } from "vitest";
import {
  importMdxMetadata,
  isMissingMdxMetadataModule,
} from "./import-mdx";

describe("importMdxMetadata", () => {
  it("returns undefined only when the requested MDX module is missing", async () => {
    await expect(importMdxMetadata("definitely-missing-og-regression")).resolves.toBeUndefined();

    const missing = Object.assign(
      new Error("Cannot find module '@/content/definitely-missing-og-regression.mdx'"),
      { code: "MODULE_NOT_FOUND" },
    );
    expect(isMissingMdxMetadataModule(missing, "definitely-missing-og-regression")).toBe(true);
  });

  it("does not hide missing dependencies or evaluation failures", () => {
    const missingDependency = Object.assign(
      new Error("Cannot find module 'missing-package' imported from article.mdx"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(isMissingMdxMetadataModule(missingDependency, "article")).toBe(false);
    expect(isMissingMdxMetadataModule(new Error("MDX evaluation failed"), "article")).toBe(false);
  });
});
