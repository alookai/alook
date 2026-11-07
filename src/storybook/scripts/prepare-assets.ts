import { fileURLToPath } from "node:url"
import { copyFile, readFile, writeFile } from "node:fs/promises"
import { prepareBlogImages } from "../../web/blog/scripts/prepare-images.mjs"
import { prepareHtmlPreview } from "../../web/src/lib/community/html-attachment-preview"

await copyFile(new URL("../../web/src/app/favicon.ico", import.meta.url), new URL("../public/favicon.ico", import.meta.url))
const raw = await readFile(new URL("../fixtures/attachment.html", import.meta.url), "utf8")
await writeFile(new URL("../public/preview/attachment.html", import.meta.url), prepareHtmlPreview(raw))
await prepareBlogImages(fileURLToPath(new URL("../../web/blog/", import.meta.url)))
