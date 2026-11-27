import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPageCover, preparePageCover } from "./pageCover";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqkAAAAASUVORK5CYII=", "base64");
it("discovers root cover conventions, honors explicit input and returns exact raster bytes", async () => {
 const dir = await mkdtemp(join(tmpdir(), "page-cover-"));
 try {
  expect(await findPageCover(dir)).toBeUndefined();
  await writeFile(join(dir, "preview.png"), png);
  expect(await findPageCover(dir)).toEqual({ data: new Uint8Array(png), contentType: "image/png" });
  await writeFile(join(dir, "cover.png"), "<svg/>");
  await expect(findPageCover(dir)).rejects.toThrow("PNG");
  expect(await findPageCover(dir, join(dir, "preview.png"))).toEqual({ data: new Uint8Array(png), contentType: "image/png" });
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
