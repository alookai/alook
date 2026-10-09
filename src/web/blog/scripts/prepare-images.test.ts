import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { prepareBlogImages } from "./prepare-images.mjs";

describe("Blog image preparation", () => {
  it("reads actual dimensions, emits responsive files, and fails on missing sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "blog-images-"));
    try {
      await mkdir(join(root, "src/content"), { recursive: true });
      await mkdir(join(root, "public/blog/example"), { recursive: true });
      await sharp({ create: { width: 1200, height: 800, channels: 3, background: "white" } }).png().toFile(join(root, "public/blog/example/hero.png"));
      await writeFile(join(root, "src/content/example.mdx"), 'export const metadata = { image: "/blog/example/hero.png" };\n![Example](/blog/example/hero.png)');
      const assets = await prepareBlogImages(root);
      expect(assets["/blog/example/hero.png"]).toMatchObject({ width: 1200, height: 800 });
      const srcSet = assets["/blog/example/hero.png"].srcSet!;
      const first = srcSet.split(" ")[0];
      expect((await sharp(await readFile(join(root, "public", first))).metadata()).width).toBe(480);
      expect(JSON.parse(await readFile(join(root, "src/lib/blog/image-assets.json"), "utf8"))).toEqual(assets);
      await writeFile(join(root, "src/content/example.mdx"), '![Missing](/blog/example/missing.png)');
      await expect(prepareBlogImages(root)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("preserves SVG picture sources and rejects unsafe paths or dimensionless metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "blog-images-picture-"));
    try {
      await mkdir(join(root, "src/content"), { recursive: true });
      await mkdir(join(root, "public/blog/example"), { recursive: true });
      await writeFile(join(root, "public/blog/example/hero.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"/>');
      const source = join(root, "src/content/example.mdx");
      await writeFile(source, '<picture><source srcSet="/blog/example/hero.svg 1200w" /><img src="/blog/example/hero.svg" alt="" /></picture>');
      expect(await prepareBlogImages(root)).toEqual({ "/blog/example/hero.svg": { width: 1200, height: 800 } });
      const probe = vi.spyOn(sharp.prototype, "metadata").mockResolvedValueOnce({} as sharp.Metadata);
      await expect(prepareBlogImages(root)).rejects.toThrow("Missing Blog image dimensions");
      probe.mockRestore();
      await writeFile(source, '![Unsafe](/blog/../private.png)');
      await expect(prepareBlogImages(root)).rejects.toThrow("Invalid Blog image");
    } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
  });

});
