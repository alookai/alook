import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { main, uploadDraft } from "./upload-google-play.mjs"

const bytes = Buffer.from("independent signed bundle bytes")
const hash = createHash("sha256").update(bytes).digest("hex")
const receipt = { package: "ai.alook.android", versionName: "0.1.63", versionCode: 10, bytes: bytes.length, sha256: hash }
const previous = { name: "active", versionCodes: ["9"], status: "completed" }
const oldDraft = { name: "old", versionCodes: ["8"], status: "draft" }
const publishedDraft = { name: "0.1.63 (10)", versionCodes: ["10"], status: "draft" }

function fixture(overrides: Record<number, unknown> = {}, failedAt = -1, failureResponse?: Response) {
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
    if (index === failedAt) return failureResponse ?? new Response("untrusted server error", { status: 403 })
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
      changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
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

  it("preserves Google's review reason without retrying or changing an unknown edit", async () => {
    const { request, calls } = fixture({}, 6, Response.json({ error: {
      code: 400, status: "FAILED_PRECONDITION", message: "Provider prose is not a receipt field",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "CHANGES_ALREADY_IN_REVIEW", metadata: { private: "excluded-metadata" } }],
    } }, { status: 400 }))
    const progress: Record<string, unknown> = {}
    await expect(uploadDraft(receipt, bytes, "offline-token", request, progress)).rejects.toThrow("FAILED_PRECONDITION, CHANGES_ALREADY_IN_REVIEW")
    expect(progress).toMatchObject({ stage: "commit-draft", commitState: "unknown", httpErrors: [{
      method: "POST", stage: "commit-draft", httpStatus: 400, responseJson: "parsed",
      googleCode: 400, googleStatus: "FAILED_PRECONDITION", reasons: ["CHANGES_ALREADY_IN_REVIEW"],
    }] })
    expect(calls).toHaveLength(7)
    expect(calls.filter(call => call.url.includes(":commit"))).toHaveLength(1)
    expect(calls.some(call => call.options.method === "DELETE")).toBe(false)
    expect(JSON.stringify(progress)).not.toContain("excluded-metadata")
    expect(JSON.stringify(progress)).not.toContain("Provider prose")
  })

  it.each([
    [{ code: 400, status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "INVALID_RELEASE" }] }, { googleCode: 400, googleStatus: "INVALID_ARGUMENT", reasons: ["INVALID_RELEASE"] }],
    [{ code: 400, errors: [{ reason: "badRequest", message: "excluded legacy prose" }] }, { googleCode: 400, reasons: ["badRequest"] }],
  ])("retains the actual Google error fields for a different 400: %j", async (error, expected) => {
    const { request } = fixture({}, 6, Response.json({ error }, { status: 400 }))
    const progress: Record<string, unknown> = {}
    await expect(uploadDraft(receipt, bytes, "offline-token", request, progress)).rejects.toThrow("HTTP 400")
    expect(progress.httpErrors).toEqual([{ method: "POST", stage: "commit-draft", httpStatus: 400, messageHint: "Unrecognized Google error message", responseJson: "parsed", ...expected }])
    expect(JSON.stringify(progress)).not.toContain("CHANGES_ALREADY_IN_REVIEW")
    expect(JSON.stringify(progress)).not.toContain("excluded legacy prose")
  })

  it.each([
    ["The query parameter changesNotSentForReview must not be set", "Google requires omitting changesNotSentForReview for this edit."],
    ["Please set the query parameter changesNotSentForReview to true", "Google requires changesNotSentForReview=true for this edit."],
  ])("explains the Google parameter instruction without retrying: %s", async (instruction, hint) => {
    const token = "SECRET_HINT_TOKEN_54"
    const { request, calls } = fixture({}, 6, Response.json({ error: { code: 400, status: "INVALID_ARGUMENT",
      message: `${instruction}. Bearer ${token} private@example.test https://private.test/?token=hidden /private/context` } }, { status: 400 }))
    const progress: Record<string, unknown> = {}
    const error = await uploadDraft(receipt, bytes, token, request, progress).catch(value => value)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain(hint)
    expect(progress.httpErrors).toEqual([{ method: "POST", stage: "commit-draft", httpStatus: 400, responseJson: "parsed",
      messageHint: hint, googleCode: 400, googleStatus: "INVALID_ARGUMENT" }])
    expect(progress).toMatchObject({ commitState: "unknown" })
    expect(calls).toHaveLength(7)
    expect(calls.filter(call => call.url.includes(":commit"))).toHaveLength(1)
    expect(calls.some(call => call.options.method === "DELETE")).toBe(false)
    for (const excluded of [token, "Bearer", "private@example.test", "https://private.test", "/private/context"]) {
      expect(JSON.stringify(progress) + error.message).not.toContain(excluded)
    }
  })

  it.each([
    ["missing", undefined],
    ["null", null],
    ["object", { access_token: "PRIVATE_HINT_CONTEXT" }],
    ["unknown", "Invalid request PRIVATE_HINT_CONTEXT"],
    ["oversized", "X".repeat(16384) + " PRIVATE_HINT_CONTEXT"],
    ["embedded", "Private context: The query parameter changesNotSentForReview must not be set. PRIVATE_HINT_CONTEXT"],
    ["word boundary", "The query parameter changesNotSentForReview must not be setValue PRIVATE_HINT_CONTEXT"],
    ["conflicting", "The query parameter changesNotSentForReview must not be set. Please set the query parameter changesNotSentForReview to true. PRIVATE_HINT_CONTEXT"],
  ])("leaves a %s Google message unrecognized without copying or guessing", async (_kind, message) => {
    const { request, calls } = fixture({}, 6, Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message } }, { status: 400 }))
    const progress: Record<string, unknown> = {}
    const error = await uploadDraft(receipt, bytes, "offline-token", request, progress).catch(value => value)
    expect(error).toBeInstanceOf(Error)
    expect(progress.httpErrors).toEqual([{ method: "POST", stage: "commit-draft", httpStatus: 400, responseJson: "parsed",
      messageHint: "Unrecognized Google error message", googleCode: 400, googleStatus: "INVALID_ARGUMENT" }])
    expect(progress).toMatchObject({ commitState: "unknown" })
    expect(calls).toHaveLength(7)
    for (const excluded of ["PRIVATE_HINT_CONTEXT", "CHANGES_ALREADY_IN_REVIEW", "Google requires", "X".repeat(128)]) {
      expect(JSON.stringify(progress) + error.message).not.toContain(excluded)
    }
  })

  it.each(["non-JSON", "body-read failure"])("keeps the HTTP error when its body has %s", async kind => {
    const response = new Response("excluded raw body", { status: 502 })
    if (kind === "body-read failure") Object.defineProperty(response, "json", { value: async () => { throw new Error("excluded read failure") } })
    const { request, calls } = fixture({}, 6, response)
    const progress: Record<string, unknown> = {}
    await expect(uploadDraft(receipt, bytes, "offline-token", request, progress)).rejects.toThrow("HTTP 502 at commit-draft")
    expect(progress.httpErrors).toEqual([{ method: "POST", stage: "commit-draft", httpStatus: 502, messageHint: "Unrecognized Google error message", responseJson: "unavailable" }])
    expect(calls).toHaveLength(7)
    expect(JSON.stringify(progress)).not.toContain("excluded")
  })

  it.each(["status", "reason"] as const)("excludes credentials in %s and arbitrary fields while retaining valid reasons", async field => {
    const token = "SECRET_TOKEN_54"
    const { request } = fixture({}, 6, Response.json({ error: {
      code: 400, status: field === "status" ? token : "FAILED_PRECONDITION", message: `Bearer ${token}`,
      details: [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: field === "reason" ? token : "CHANGES_ALREADY_IN_REVIEW", metadata: { Authorization: `Bearer ${token}` } },
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "CHANGES_ALREADY_IN_REVIEW" },
        { "@type": "untrusted-type", reason: "EXCLUDED_WRONG_TYPE" },
      ],
      errors: [{ reason: "CHANGES_ALREADY_IN_REVIEW" }, { reason: "Bearer OTHER_SECRET" }, { reason: "X".repeat(129) }],
    } }, { status: 400 }))
    const progress: Record<string, unknown> = {}
    const error = await uploadDraft(receipt, bytes, token, request, progress).catch(value => value)
    expect(error).toBeInstanceOf(Error)
    expect(progress.httpErrors).toEqual([{ method: "POST", stage: "commit-draft", httpStatus: 400, messageHint: "Unrecognized Google error message", responseJson: "parsed", googleCode: 400,
      ...(field === "status" ? {} : { googleStatus: "FAILED_PRECONDITION" }), reasons: ["CHANGES_ALREADY_IN_REVIEW"] }])
    for (const excluded of [token, "Bearer", "Authorization", "metadata", "EXCLUDED_WRONG_TYPE", "X".repeat(129)]) {
      expect(JSON.stringify(progress) + error.message).not.toContain(excluded)
    }
  })

  it("retains HTTP errors in order when the original operation and cleanup both fail", async () => {
    const { request, calls } = fixture({}, 3, Response.json({ error: { code: 403, status: "PERMISSION_DENIED" } }, { status: 403 }))
    const failingCleanup = async (url: string, options: RequestInit) => {
      if (options.method !== "DELETE") return request(url, options)
      calls.push({ url, options })
      return new Response(null, { status: 503 })
    }
    const progress: Record<string, unknown> = {}
    const error = await uploadDraft(receipt, bytes, "offline-token", failingCleanup, progress).catch(value => value)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors[0].message).toContain("HTTP 403")
    expect(error.errors[1].message).toContain("HTTP 503")
    expect(progress).toMatchObject({ cleanupFailed: true, httpErrors: [
      { method: "POST", stage: "upload-bundle", httpStatus: 403, responseJson: "parsed", googleCode: 403, googleStatus: "PERMISSION_DENIED" },
      { method: "DELETE", stage: "upload-bundle", httpStatus: 503, responseJson: "unavailable" },
    ] })
  })

  it.each([
    [{ code: 400, status: "FAILED_PRECONDITION", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "CHANGES_ALREADY_IN_REVIEW" }] },
      { googleStatus: "FAILED_PRECONDITION", reasons: ["CHANGES_ALREADY_IN_REVIEW"], messageHint: "Unrecognized Google error message" }],
    [{ code: 400, status: "INVALID_ARGUMENT", message: "The query parameter changesNotSentForReview must not be set. SECRET_DYNAMIC_CONTEXT" },
      { googleStatus: "INVALID_ARGUMENT", messageHint: "Google requires omitting changesNotSentForReview for this edit." }],
  ])("writes the HTTP diagnosis into the real main failure receipt: %j", async (providerError, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "alook-play-http-error-"))
    const bundle = join(dir, "bundle.aab"), input = join(dir, "bundle.json"), output = join(dir, "result.json")
    const { request, calls } = fixture({}, 6, Response.json({ error: providerError }, { status: 400 }))
    try {
      writeFileSync(bundle, bytes)
      writeFileSync(input, JSON.stringify({ ...receipt, path: bundle }))
      vi.stubGlobal("fetch", request)
      vi.stubEnv("GOOGLE_PLAY_ACCESS_TOKEN", "offline-token")
      await expect(main([input, output])).rejects.toThrow("HTTP 400")
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ stage: "commit-draft", committed: false, commitState: "unknown",
        readback: false, editId: "write-edit", success: false, httpErrors: [{ method: "POST", stage: "commit-draft", httpStatus: 400,
          responseJson: "parsed", googleCode: 400, ...expected }] })
      expect(readFileSync(output, "utf8")).not.toContain("SECRET_DYNAMIC_CONTEXT")
      expect(calls).toHaveLength(7)
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves confirmed business state when read-edit cleanup fails", async () => {
    const { request } = fixture()
    const progress: Record<string, unknown> = {}
    const failingCleanup = async (url: string, options: RequestInit) => options.method === "DELETE"
      ? new Response(null, { status: 503 }) : request(url, options)
    await expect(uploadDraft(receipt, bytes, "offline-token", failingCleanup, progress)).rejects.toThrow("cleanup failed")
    expect(progress).toMatchObject({ committed: true, readback: true, cleanupFailed: true })
    expect(progress.httpErrors).toEqual([{ method: "DELETE", stage: "confirmed", httpStatus: 503, messageHint: "Unrecognized Google error message", responseJson: "unavailable" }])
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
