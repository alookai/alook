import { Fragment, createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { artworkByFace, type FaceKind } from "./BotArtwork"

function renderFace(face: FaceKind) {
  return renderToStaticMarkup(createElement(Fragment, null, artworkByFace[face](1, 16)))
}

describe("Alook loading artwork", () => {
  it.each(["red", "purple"] as const)("keeps the %s face expression white-only", (face) => {
    const html = renderFace(face)

    expect(html.match(/fill="white"/g)).toHaveLength(3)
    expect(html).not.toContain("#171313")
  })

  it("preserves dark expression paths on the faces that own them", () => {
    expect(renderFace("teal")).toContain("#171313")
    expect(renderFace("blue")).toContain("#171313")
    expect(renderFace("orange")).toContain("#171313")
  })
})
