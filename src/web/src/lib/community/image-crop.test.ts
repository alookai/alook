import { describe, it, expect } from "vitest"
import { MAX_ICON_SOURCE_FILE_SIZE_BYTES } from "@alook/shared"
import { validateIconSourceFile, deriveCroppedFileName, buildCroppedIconFile } from "./image-crop"

function fakeFile(name: string, type: string, size: number): File {
  return {
    name,
    type,
    size,
  } as File
}

describe("validateIconSourceFile", () => {
  it("accepts png/jpeg/webp under the size cap", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(validateIconSourceFile(fakeFile("f.png", type, 1024))).toEqual({ ok: true })
    }
  })

  it("rejects oversized files regardless of MIME", () => {
    const file = fakeFile("big.png", "image/png", MAX_ICON_SOURCE_FILE_SIZE_BYTES + 1)
    const result = validateIconSourceFile(file)
    expect(result.ok).toBe(false)
  })

  it("rejects disallowed MIME types (e.g. image/gif) even under the size cap", () => {
    const file = fakeFile("f.gif", "image/gif", 1024)
    const result = validateIconSourceFile(file)
    expect(result.ok).toBe(false)
  })
})

describe("deriveCroppedFileName", () => {
  it("strips various extensions and appends exactly one .webp", () => {
    expect(deriveCroppedFileName("photo.png")).toBe("photo.webp")
    expect(deriveCroppedFileName("photo.jpeg")).toBe("photo.webp")
    expect(deriveCroppedFileName("my.photo.jpg")).toBe("my.photo.webp")
  })

  it("appends .webp when there is no extension", () => {
    expect(deriveCroppedFileName("photo")).toBe("photo.webp")
  })
})

describe("buildCroppedIconFile", () => {
  it("resulting File.type is always image/webp, name ends in .webp", () => {
    const blob = new Blob(["x"], { type: "image/png" })
    const file = buildCroppedIconFile(blob, "original.png")
    expect(file.type).toBe("image/webp")
    expect(file.name.endsWith(".webp")).toBe(true)
  })
})
