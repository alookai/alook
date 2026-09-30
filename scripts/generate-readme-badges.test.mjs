import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { extractPngIcon, makeReadmeBadge } from "./generate-readme-badges.mjs"

test("the checked-in Alook Join badge matches its favicon source", async () => {
  const favicon = await readFile(new URL("../src/web/src/app/favicon.ico", import.meta.url))
  const checkedInBadge = await readFile(new URL("../assets/readme/alook-join.svg", import.meta.url), "utf8")
  const generatedBadge = makeReadmeBadge(favicon)
  const embeddedLogo = generatedBadge.match(/data:image\/png;base64,([^\"]+)/)?.[1]

  assert.equal(generatedBadge, checkedInBadge)
  assert.match(generatedBadge, /width="89" height="20"/)
  assert.match(generatedBadge, /aria-label="Alook: Join"/)
  assert.ok(embeddedLogo)
  assert.deepEqual(Buffer.from(embeddedLogo, "base64"), extractPngIcon(favicon))
})
