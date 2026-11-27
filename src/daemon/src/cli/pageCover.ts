import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { PAGE_COVER_MAX_BYTES, pageCoverContentType } from "@alook/shared";

export async function preparePageCover(file: string) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > PAGE_COVER_MAX_BYTES) throw new Error("Page cover must be a file of at most 2 MiB");
    const bytes = new Uint8Array(PAGE_COVER_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const data = bytes.slice(0, length);
    const contentType = pageCoverContentType(data);
    if (!contentType) throw new Error("Page cover requires PNG, JPEG or WebP bytes, at most 2 MiB");
    return { data, contentType };
  } finally { await handle.close(); }
}

export async function findPageCover(directory: string, explicit?: string) {
  if (explicit !== undefined) return preparePageCover(explicit);
  for (const base of ["cover", "preview"]) {
    for (const extension of ["png", "jpg", "jpeg", "webp"]) {
      const file = join(directory, `${base}.${extension}`);
      const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (info) return preparePageCover(file);
    }
  }
  return undefined;
}
