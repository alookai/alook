import { fileURLToPath } from "node:url"
import { readFile, writeFile } from "node:fs/promises"
import { prepareBlogImages } from "../../web/blog/scripts/prepare-images.mjs"
import { prepareHtmlPreview } from "../../web/src/lib/community/html-attachment-preview"

const raw = await readFile(new URL("../fixtures/attachment.html", import.meta.url), "utf8")
await writeFile(new URL("../public/preview/attachment.html", import.meta.url), prepareHtmlPreview(raw))
await prepareBlogImages(fileURLToPath(new URL("../../web/blog/", import.meta.url)))
