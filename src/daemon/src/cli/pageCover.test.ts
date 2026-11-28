import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preparePageCover } from "./pageCover";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqkAAAAASUVORK5CYII=", "base64");
it("returns exact raster bytes for a valid PNG cover file", async () => {
 const dir = await mkdtemp(join(tmpdir(), "page-cover-"));
 try {
  const file = join(dir, "cover.png");
  await writeFile(file, png);
  expect(await preparePageCover(file)).toEqual({ data: new Uint8Array(png), contentType: "image/png" });
 } finally { await rm(dir, { recursive: true, force: true }); }
});
it("rejects unsupported, oversized and symbolic image files", async () => {
 const dir = await mkdtemp(join(tmpdir(), "page-cover-"));
 try {
  const file = join(dir, "cover.png"); await writeFile(file, new Uint8Array(2 * 1024 * 1024 + 1));
  await expect(preparePageCover(file)).rejects.toThrow("2 MiB");
  await writeFile(file, "<html>bad</html>"); await expect(preparePageCover(file)).rejects.toThrow("PNG");
  if (process.platform !== "win32") { const link = join(dir, "link.png"); await symlink(file, link); await expect(preparePageCover(link)).rejects.toThrow(); }
 } finally { await rm(dir, { recursive: true, force: true }); }
});
it("accepts actual JPEG and WebP covers without filename-based type trust", async () => {
 const { default: sharp } = await import("sharp");
 const dir = await mkdtemp(join(tmpdir(), "page-cover-"));
 try {
  for (const format of ["jpeg", "webp"] as const) {
   const data = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })[format]().toBuffer();
   const file = join(dir, "image.bin"); await writeFile(file, data);
   expect((await preparePageCover(file)).contentType).toBe(`image/${format}`);
  }
 } finally { await rm(dir, { recursive: true, force: true }); }
});
