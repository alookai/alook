import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { uploadDraft } from "./upload-google-play.mjs"

const bytes = Buffer.from("independent signed bundle bytes")
const hash = createHash("sha256").update(bytes).digest("hex")
const receipt = { package: "ai.alook.android", versionName: "0.1.63", versionCode: 10, bytes: bytes.length, sha256: hash }
const previous = { name: "active", versionCodes: ["9"], status: "completed" }
const oldDraft = { name: "old", versionCodes: ["8"], status: "draft" }
const publishedDraft = { name: "0.1.63 (10)", versionCodes: ["10"], status: "draft" }

function fixture(overrides: Record<number, unknown> = {}, failedAt = -1) {
  const payloads = [
    { id: "write-edit" }, { bundles: [{ versionCode: 9 }] }, { apks: [{ versionCode: 8 }] },
    { versionCode: 10, sha256: hash }, { track: "internal", releases: [previous, oldDraft] },
    { track: "internal", releases: [previous, publishedDraft] }, { id: "write-edit" }, { id: "read-edit" },
    { track: "internal", releases: [previous, publishedDraft] }, { bundles: [{ versionCode: 10, sha256: hash }] },
  ]
  const calls: { url: string, options: RequestInit }[] = []
  const request = async (url: string, options: RequestInit) => {
    const index = calls.length
    calls.push({ url, options })
    if (options.method === "DELETE") return new Response(null, { status: 204 })
    if (index === failedAt) return new Response("untrusted server error", { status: 403 })
    return Response.json(Object.hasOwn(overrides, index) ? overrides[index] : payloads[index])
  }
  return { calls, request }
}

describe("verified bundle to Google Play internal draft", () => {
  it("uploads the bound bytes, preserves active releases and reads the committed draft/hash back", async () => {
    const { calls, request } = fixture()
    const progress: Record<string, unknown> = {}
    const expectedBytes = Buffer.from(bytes)
    const result = await uploadDraft(receipt, bytes, "offline-token", request, progress)
    expect(result).toEqual({ package: "ai.alook.android", track: "internal", status: "draft", versionCode: 10,
      sha256: hash, editId: "write-edit", committed: true, readback: true })
    expect(calls.map(call => [call.options.method, new URL(call.url).pathname])).toEqual([
      ["POST", "/androidpublisher/v3/applications/ai.alook.android/edits"],
      ["GET", "/androidpublisher/v3/applications/ai.alook.android/edits/write-edit/bundles"],
      ["GET", "/androidpublisher/v3/applications/ai.alook.android/edits/write-edit/apks"],
      ["POST", "/upload/androidpublisher/v3/applications/ai.alook.android/edits/write-edit/bundles"],
      ["GET", "/androidpublisher/v3/applications/ai.alook.android/edits/write-edit/tracks/internal"],
      ["PUT", "/androidpublisher/v3/applications/ai.alook.android/edits/write-edit/tracks/internal"],
      ["POST", "/androidpublisher/v3/applications/ai.alook.android/edits/write-edit:commit"],
      ["POST", "/androidpublisher/v3/applications/ai.alook.android/edits"],
      ["GET", "/androidpublisher/v3/applications/ai.alook.android/edits/read-edit/tracks/internal"],
      ["GET", "/androidpublisher/v3/applications/ai.alook.android/edits/read-edit/bundles"],
      ["DELETE", "/androidpublisher/v3/applications/ai.alook.android/edits/read-edit"],
    ])
    expect(calls[3].options.body).toEqual(expectedBytes)
    expect(new URL(calls[3].url).searchParams.get("uploadType")).toBe("media")
    expect(JSON.parse(calls[5].options.body as string)).toEqual({ track: "internal", releases: [previous, publishedDraft] })
    expect(calls[6].options.body).toBeUndefined()
    expect(Object.fromEntries(new URL(calls[6].url).searchParams)).toEqual({
      changesNotSentForReview: "true", changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
    })
    expect(JSON.stringify(result)).not.toContain("offline-token")
    expect(progress).toMatchObject({ stage: "confirmed", committed: true, commitState: "confirmed", readback: true })
  })

  it.each([
    { ...receipt, package: "wrong.app" }, { ...receipt, versionCode: 0 },
    { ...receipt, bytes: 1 }, { ...receipt, sha256: "0".repeat(64) },
  ])("refuses an unbound input before any external edit: %j", async altered => {
    const { request, calls } = fixture()
    await expect(uploadDraft(altered, bytes, "offline-token", request)).rejects.toThrow("verified bundle receipt")
    expect(calls).toHaveLength(0)
  })

  it("rejects missing auth without exposing or calling it", async () => {
    const { request, calls } = fixture()
    await expect(uploadDraft(receipt, bytes, "", request)).rejects.toThrow("Missing Google Play access token")
    expect(calls).toHaveLength(0)
  })

  it.each([["bundles", 10], ["bundles", 11], ["apks", 10], ["apks", 11]] as const)("refuses reused or lower version code when Play %s already has %s", async (kind, versionCode) => {
    const { request, calls } = fixture({ [kind === "bundles" ? 1 : 2]: { [kind]: [{ versionCode }] } })
    await expect(uploadDraft(receipt, bytes, "offline-token", request)).rejects.toThrow("start a new workflow run")
    expect(calls.filter(call => call.options.method === "POST")).toHaveLength(1)
    expect(calls.at(-1)?.options.method).toBe("DELETE")
  })

  it.each([
    [3, { versionCode: 10, sha256: "0".repeat(64) }, "upload version/hash"],
    [3, { versionCode: 11, sha256: hash }, "upload version/hash"],
    [4, { track: "production" }, "different track"],
    [8, { track: "internal", releases: [{ status: "completed", versionCodes: ["10"] }] }, "readback"],
    [9, { bundles: [{ versionCode: 10, sha256: "0".repeat(64) }] }, "readback"],
  ] as const)("retains failure at independent response boundary %s", async (index, response, error) => {
    const { request, calls } = fixture({ [index]: response })
    const progress: Record<string, unknown> = {}
    await expect(uploadDraft(receipt, bytes, "offline-token", request, progress)).rejects.toThrow(error)
    if (index < 6) expect(calls.some(call => call.url.includes(":commit"))).toBe(false)
    else expect(progress).toMatchObject({ committed: true, commitState: "confirmed", stage: "readback" })
    expect(JSON.stringify(progress)).not.toContain("offline-token")
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])("propagates HTTP failure at step %s without retrying mutation", async failedAt => {
    const { request, calls } = fixture({}, failedAt)
    const progress: Record<string, unknown> = {}
    await expect(uploadDraft(receipt, bytes, "offline-token", request, progress)).rejects.toThrow("HTTP 403")
    expect(calls.filter(call => call.url.includes(":commit"))).toHaveLength(failedAt >= 6 ? 1 : 0)
    if (failedAt === 6) {
      expect(progress.commitState).toBe("unknown")
      expect(calls.at(-1)?.options.method).toBe("POST")
    }
  })

  it("preserves confirmed business state when read-edit cleanup fails", async () => {
    const { request } = fixture()
    const progress: Record<string, unknown> = {}
    const failingCleanup = async (url: string, options: RequestInit) => options.method === "DELETE"
      ? new Response(null, { status: 503 }) : request(url, options)
    await expect(uploadDraft(receipt, bytes, "offline-token", failingCleanup, progress)).rejects.toThrow("cleanup failed")
    expect(progress).toMatchObject({ committed: true, readback: true, cleanupFailed: true })
  })
})

describe("actual Mobile Release job admission", () => {
  const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/mobile-release.yml"), "utf8")
  const condition = (job: string) => {
    const expression = workflow.split(`  ${job}:\n`)[1].match(/^    if: (.+)$/m)![1]
    return new Function("github", "inputs", `return ${expression}`) as (github: { event_name: string }, inputs: object) => boolean
  }
  it.each([
    ["push", {}, true, true],
    ["workflow_dispatch", { ios: false, android: true }, false, true],
    ["workflow_dispatch", { ios: true, android: false, play_upload: false }, true, false],
    ["workflow_dispatch", { ios: false, android: false, play_upload: true }, false, true],
  ])("admits requested platforms for %s %j", (event_name, inputs, ios, android) => {
    expect(condition("build-ios")({ event_name }, inputs)).toBe(ios)
    expect(condition("build-android")({ event_name }, inputs)).toBe(android)
  })

  it.each([
    ["push", {}, [true, true, true]],
    ["workflow_dispatch", { ios: false, android: true, play_upload: false }, [false, false, false]],
    ["workflow_dispatch", { ios: false, android: true, play_upload: true }, [false, false, false]],
  ])("protects public Release writes for %s %j", (event_name, inputs, expected) => {
    const operations = ["Resolve GitHub release", "Attach APK to GitHub release", "Append Android download to release body"]
    const admitted = operations.map(name => {
      const step = workflow.split(`      - name: ${name}\n`)[1].split("      - name:")[0]
      const expression = step.match(/^        if: (.+)$/m)?.[1]
      const run = new Function("github", "inputs", `return ${expression ?? "true"}`)
      return run({ event_name }, inputs)
    })
    expect(admitted).toEqual(expected)
  })
})
