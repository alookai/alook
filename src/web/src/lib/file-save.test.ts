import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { downloadUrl, saveFile, fileSaveName, FILE_SAVE_CHUNK_BYTES } from "./file-save"
const bridge = vi.hoisted(() => ({ native: false, invoke: vi.fn() }))
vi.mock("@alook/shared", () => ({ isTauri: () => bridge.native, tauriInvoke: bridge.invoke }))
const id = "00000000-0000-4000-8000-000000000001"
function browser() {
  const anchor = { href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() }
  vi.stubGlobal("document", { createElement: vi.fn(() => anchor), body: { appendChild: vi.fn() } })
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:save"), revokeObjectURL: vi.fn() })
  return anchor
}
function native() {
  bridge.native = true
  let bytes = 0
  let name = ""
  let mime = ""
  bridge.invoke.mockImplementation(async (command, { payload } = {}) => {
    if (command === "file_save_begin") { name = payload.name; mime = payload.mime; return { attemptId: id } }
    if (command === "file_save_write_chunk") { bytes += atob(payload.data).length; return { attemptId: id, bytes, sequence: payload.sequence + 1 } }
    if (command === "file_save_commit") return { attemptId: id, bytes, name, mime, sha256: "a".repeat(64), destination: "desktop", status: "saved" }
  })
}
beforeEach(() => { bridge.native = false; bridge.invoke.mockReset(); vi.stubGlobal("crypto", { randomUUID: () => id }); vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe("product file save", () => {
  it("uses authenticated fetch and reports browser started, retaining the URL while download begins", async () => {
    const anchor = browser()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("abc", { headers: { "content-length": "3" } })))
    expect(await downloadUrl("/private/file", "报告.txt")).toEqual({ status: "started" })
    expect(fetch).toHaveBeenCalledWith("/private/file", { credentials: "same-origin", signal: undefined })
    expect(anchor.download).toBe("报告.txt"); expect(anchor.click).toHaveBeenCalledOnce()
    expect(anchor.remove).toHaveBeenCalledOnce(); expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:save")
  })
  it("streams sequential bounded native chunks and validates the final receipt", async () => {
    native()
    const data = new Uint8Array(FILE_SAVE_CHUNK_BYTES * 2 + 1).fill(127)
    expect(await saveFile(new Blob([data]), "a.bin")).toEqual(expect.objectContaining({ status: "saved", bytes: data.length }))
    const chunks = bridge.invoke.mock.calls.filter(([command]) => command === "file_save_write_chunk").map(([, args]) => args.payload)
    expect(chunks.map(c => c.sequence)).toEqual([0, 1, 2])
    expect(chunks.map(c => c.offset)).toEqual([0, FILE_SAVE_CHUNK_BYTES, FILE_SAVE_CHUNK_BYTES * 2])
    expect(chunks.map(c => atob(c.data).length)).toEqual([FILE_SAVE_CHUNK_BYTES, FILE_SAVE_CHUNK_BYTES, 1])
    expect(bridge.invoke).not.toHaveBeenCalledWith("file_save_cancel", expect.anything())
  })
  it.each(["name", "mime", "bytes", "sha256", "attemptId", "destination", "status"])("rejects invalid native %s without browser fallback", async field => {
    browser(); native()
    const original = bridge.invoke.getMockImplementation()!
    bridge.invoke.mockImplementation(async (...args) => {
      const result = await original(...args)
      return args[0] === "file_save_commit" ? { ...result, [field]: "invalid" } : result
    })
    expect((await saveFile(new Blob(["a"]), "a.txt")).status).toBe("error")
    expect(bridge.invoke).toHaveBeenCalledWith("file_save_cancel", { attemptId: id })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
  it("cleans up native staging on a wrong chunk ack", async () => {
    native(); bridge.invoke.mockResolvedValue({ attemptId: id, bytes: 99, sequence: 1 })
    expect((await saveFile(new Blob(["a"]), "a")).status).toBe("error")
    expect(bridge.invoke).toHaveBeenCalledWith("file_save_cancel", { attemptId: id })
  })
  it("keeps picker cancellation neutral", async () => {
    native(); const original = bridge.invoke.getMockImplementation()!
    bridge.invoke.mockImplementation(async (...args) => args[0] === "file_save_commit" ? { attemptId: id, status: "cancelled" } : original(...args))
    expect(await saveFile(new Blob([]), "empty")).toEqual({ status: "cancelled" })
  })
  it("cancels a reader and native attempt on abort during streaming", async () => {
    native(); const controller = new AbortController()
    const original = bridge.invoke.getMockImplementation()!
    bridge.invoke.mockImplementation(async (...args) => { const value = await original(...args); if (args[0] === "file_save_write_chunk") controller.abort(); return value })
    expect(await saveFile(new Blob(["a"]), "a", { signal: controller.signal })).toEqual({ status: "cancelled" })
    expect(bridge.invoke).toHaveBeenCalledWith("file_save_cancel", { attemptId: id })
    expect(bridge.invoke.mock.calls.some(([c]) => c === "file_save_commit")).toBe(false)
  })
  it.each(["http", "missing-body", "short-body", "stream-error"])("does not report success on %s", async kind => {
    const anchor = browser()
    const response = kind === "http" ? new Response("no", { status: 403 })
      : kind === "missing-body" ? new Response(null)
        : kind === "short-body" ? new Response("a", { headers: { "content-length": "2" } })
          : new Response(new ReadableStream({ start(c) { c.error(new Error("read failed")) } }))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response))
    expect((await downloadUrl("/file", "a")).status).toBe("error"); expect(anchor.click).not.toHaveBeenCalled()
  })
  it("ignores compressed transfer length and accepts unknown length and empty files", async () => {
    native(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("abc", { headers: { "content-length": "1", "content-encoding": "gzip" } })))
    expect((await downloadUrl("/file", "a")).status).toBe("saved")
    expect(bridge.invoke).toHaveBeenCalledWith("file_save_begin", { payload: expect.objectContaining({ size: null }) })
    native(); expect((await saveFile(new Blob([]), "empty")).status).toBe("saved")
  })
  it("cleans browser resources when the click fails", async () => {
    const anchor = browser(); anchor.click.mockImplementation(() => { throw new Error("blocked") })
    expect((await saveFile(new Blob(["x"]), "a")).status).toBe("error")
    expect(anchor.remove).toHaveBeenCalled(); vi.advanceTimersByTime(60_000); expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
  it("sanitizes paths, controls, reserved names and UTF-8 length", () => {
    expect(fileSaveName("../CON.txt")).toBe("_CON.txt")
    expect(fileSaveName("a\\b\0:c?.txt  ")).toBe("b_c_.txt")
    expect(fileSaveName("...")).toBe("download")
    expect(new TextEncoder().encode(fileSaveName("中".repeat(100))).length).toBeLessThanOrEqual(180)
  })
})
