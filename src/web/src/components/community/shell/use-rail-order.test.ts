import { describe, it, expect } from "vitest"
import { folderId, isFolderKey, extractFolderId, FOLDER_PREFIX } from "./use-rail-order"

describe("folder key helpers", () => {
  it("creates a folder key with prefix", () => {
    expect(folderId("abc")).toBe("folder:abc")
  })

  it("detects folder keys", () => {
    expect(isFolderKey("folder:abc")).toBe(true)
    expect(isFolderKey("server_123")).toBe(false)
    expect(isFolderKey("")).toBe(false)
  })

  it("extracts folder id from key", () => {
    expect(extractFolderId("folder:abc")).toBe("abc")
    expect(extractFolderId("folder:")).toBe("")
  })

  it("FOLDER_PREFIX is consistent", () => {
    expect(FOLDER_PREFIX).toBe("folder:")
  })
})
