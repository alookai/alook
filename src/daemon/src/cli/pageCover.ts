import { constants } from "node:fs";
import { open } from "node:fs/promises";
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
