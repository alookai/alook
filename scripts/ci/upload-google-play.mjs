import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const packageName = "ai.alook.android"
const editsUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/edits`
const uploadUrl = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${packageName}/edits`

export async function uploadDraft(receipt, bytes, token, request = fetch, progress = {}) {
  if (!token) throw new Error("Missing Google Play access token")
  if (receipt.package !== packageName || !Number.isSafeInteger(receipt.versionCode) || receipt.versionCode < 1 ||
      receipt.bytes !== bytes.length || createHash("sha256").update(bytes).digest("hex") !== receipt.sha256) {
    throw new Error("Google Play input differs from the verified bundle receipt")
  }
  const api = async (method, url, body, media = false) => {
    const response = await request(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": media ? "application/octet-stream" : "application/json" }) },
      body: body === undefined ? undefined : media ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(media ? 300_000 : 60_000),
    })
    if (!response.ok) {
      const failure = { method, stage: progress.stage, httpStatus: response.status, messageHint: "Unrecognized Google error message" }
      let payload
      try { payload = await response.json(); failure.responseJson = "parsed" } catch { failure.responseJson = "unavailable" }
      const error = payload?.error
      const instructions = [
        ["The query parameter changesNotSentForReview must not be set", "Google requires omitting changesNotSentForReview for this edit."],
        ["Please set the query parameter changesNotSentForReview to true", "Google requires changesNotSentForReview=true for this edit."],
      ].filter(([instruction]) => typeof error?.message === "string" && error.message.includes(instruction))
      if (instructions.length === 1 && error.message.startsWith(instructions[0][0]) &&
          /^[.:\s]?$/.test(error.message.slice(instructions[0][0].length, instructions[0][0].length + 1))) {
        failure.messageHint = instructions[0][1]
      }
      const identifier = (value, pattern) => typeof value === "string" && pattern.test(value) && !value.includes(String(token)) ? value : undefined
      if (Number.isInteger(error?.code) && error.code >= 100 && error.code <= 599) failure.googleCode = error.code
      const status = identifier(error?.status, /^[A-Z][A-Z0-9_]{0,127}$/)
      if (status) failure.googleStatus = status
      const reasons = [
        ...(Array.isArray(error?.details) ? error.details.filter(row => row?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo").map(row => row.reason) : []),
        ...(Array.isArray(error?.errors) ? error.errors.map(row => row?.reason) : []),
      ].map(value => identifier(value, /^[A-Za-z][A-Za-z0-9_]{0,127}$/)).filter(Boolean)
      if (reasons.length) failure.reasons = [...new Set(reasons)]
      progress.httpErrors ??= []
      progress.httpErrors.push(failure)
      const detail = [failure.googleStatus, ...(failure.reasons ?? []), failure.messageHint].filter(Boolean).join(", ")
      throw new Error(`Google Play ${method} failed with HTTP ${response.status} at ${progress.stage}${detail ? ` (${detail})` : ""}`)
    }
    return response.status === 204 ? {} : response.json()
  }
  const edit = async () => {
    const value = await api("POST", editsUrl, {})
    if (typeof value.id !== "string" || !value.id) throw new Error("Google Play returned no edit identity")
    return value.id
  }
  const path = id => `${editsUrl}/${encodeURIComponent(id)}`
  let editId
  let readId
  let originalError
  try {
    progress.stage = "create-edit"
    editId = await edit()
    progress.editId = editId
    progress.stage = "version-admission"
    const bundles = await api("GET", `${path(editId)}/bundles`)
    const apks = await api("GET", `${path(editId)}/apks`)
    const existing = [...(bundles.bundles ?? []), ...(apks.apks ?? [])]
    if (existing.some(row => !Number.isSafeInteger(row.versionCode) || row.versionCode >= receipt.versionCode)) {
      throw new Error("Android versionCode must exceed existing Play bundles/APKs; start a new workflow run instead of rerunning an uploaded version")
    }
    progress.stage = "upload-bundle"
    const uploaded = await api("POST", `${uploadUrl}/${encodeURIComponent(editId)}/bundles?uploadType=media`, bytes, true)
    if (uploaded.versionCode !== receipt.versionCode || uploaded.sha256 !== receipt.sha256) {
      throw new Error("Google Play upload version/hash differs from the verified bundle")
    }
    progress.stage = "update-internal-draft"
    const current = await api("GET", `${path(editId)}/tracks/internal`)
    if (current.track !== "internal") throw new Error("Google Play returned a different track")
    const draft = { name: `${receipt.versionName} (${receipt.versionCode})`, versionCodes: [String(receipt.versionCode)], status: "draft" }
    const track = { track: "internal", releases: [...(current.releases ?? []).filter(row => row.status !== "draft"), draft] }
    await api("PUT", `${path(editId)}/tracks/internal`, track)
    progress.stage = "commit-draft"
    progress.commitState = "unknown"
    const committed = await api("POST", `${path(editId)}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`)
    if (committed.id !== editId) throw new Error("Google Play returned a different committed edit")
    progress.committed = true
    progress.commitState = "confirmed"
    progress.stage = "readback"
    readId = await edit()
    const observed = await api("GET", `${path(readId)}/tracks/internal`)
    const observedBundles = await api("GET", `${path(readId)}/bundles`)
    if (observed.track !== "internal" || !observed.releases?.some(row => row.status === "draft" && row.versionCodes?.includes(String(receipt.versionCode))) ||
        !observedBundles.bundles?.some(row => row.versionCode === receipt.versionCode && row.sha256 === receipt.sha256)) {
      throw new Error("Committed internal draft/bundle was not confirmed by Google Play readback")
    }
    progress.stage = "confirmed"
    progress.readback = true
    return { package: packageName, track: "internal", status: "draft", versionCode: receipt.versionCode,
      sha256: receipt.sha256, editId, committed: true, readback: true }
  } catch (error) {
    originalError = error
    throw error
  } finally {
    const cleanupErrors = []
    const cleanupIds = [readId, progress.commitState === "unknown" || progress.committed ? undefined : editId].filter(Boolean)
    for (const id of cleanupIds) {
      try { await api("DELETE", path(id)) } catch (error) { cleanupErrors.push(error) }
    }
    if (cleanupErrors.length) {
      progress.cleanupFailed = true
      throw new AggregateError([...(originalError ? [originalError] : []), ...cleanupErrors],
        `${originalError ? originalError.message + "; " : ""}Google Play edit cleanup failed`)
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2) throw new Error("Expected verified bundle receipt and upload result paths")
  const receipt = JSON.parse(readFileSync(args[0], "utf8"))
  const progress = { stage: "input", committed: false, commitState: "not-attempted", readback: false }
  try {
    const result = await uploadDraft(receipt, readFileSync(receipt.path), process.env.GOOGLE_PLAY_ACCESS_TOKEN, fetch, progress)
    writeFileSync(args[1], JSON.stringify(result, null, 2) + "\n")
    process.stdout.write(JSON.stringify(result) + "\n")
  } catch (error) {
    writeFileSync(args[1], JSON.stringify({ ...progress, success: false }, null, 2) + "\n")
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
