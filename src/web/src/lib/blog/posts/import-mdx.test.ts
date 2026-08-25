import { describe, expect, it, vi } from "vitest";
import {
  importMdxMetadata,
  isMissingMdxMetadataModule,
} from "./import-mdx";

const { evaluationFailure, metadata } = vi.hoisted(() => ({
  metadata: {
    slug: "ai-agent-identity",
    title: "Article",
    date: "2026-08-26",
    author: "Alook",
    excerpt: "Article excerpt",
    readingTime: "1 min read",
  },
  evaluationFailure: new Error("MDX evaluation failed"),
}));

vi.mock("@/content/ai-agent-identity.mdx", () => ({ metadata }));
vi.mock("@/content/humans-and-ai-agents-in-one-room.mdx", () => ({
  get metadata() {
    throw evaluationFailure;
  },
}));

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
    expect(isMissingMdxMetadataModule("not an error", "article")).toBe(false);
  });

  it("returns loaded metadata and propagates unexpected loader failures", async () => {
    await expect(importMdxMetadata("ai-agent-identity")).resolves.toEqual(metadata);
    await expect(
      importMdxMetadata("humans-and-ai-agents-in-one-room"),
    ).rejects.toBe(evaluationFailure);
  });
});
