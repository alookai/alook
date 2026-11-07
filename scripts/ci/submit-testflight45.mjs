import { sign } from "node:crypto"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import { createPreflightClient, inspectPreflight } from "./inspect-testflight-preflight.mjs"
import { TARGET } from "./inspect-testflight-build.mjs"

export const CONFIRM_TARGET = "ai.alook.ios:0.1.64:45"
export const NATIVE_TEST_NOTES = "On iPhone, test the top and bottom shell colors in light and dark themes. Open and dismiss the keyboard; check that the input area moves smoothly and stays aligned."
const ORIGIN = "https://api.appstoreconnect.apple.com"
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value)

export class SubmitError extends Error {
  constructor(code, httpStatus = null, errorCodes = []) {
    super(code)
    this.code = code
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null
    this.errorCodes = Array.isArray(errorCodes) ? errorCodes.slice(0, 5).filter(value => typeof value === "string" && /^[A-Z][A-Z0-9_.]{0,79}$/.test(value)) : []
  }
}

export function writeFor(operation, ids) {
  if (![ids?.appId, ids?.buildId, ids?.groupId, ids?.noteId].every(validId) || ids?.locale !== "en-US") throw new SubmitError("INVALID_VERIFIED_IDENTITIES")
  const build = { type: "builds", id: ids.buildId }
  if (operation === "updateExistingNativeNotes") return { url: new URL(`/v1/betaBuildLocalizations/${ids.noteId}`, ORIGIN), method: "PATCH", body: {
    data: { type: "betaBuildLocalizations", id: ids.noteId, attributes: { whatsNew: NATIVE_TEST_NOTES } },
  } }
  if (operation === "associateExistingGroup") return { url: new URL(`/v1/builds/${ids.buildId}/relationships/betaGroups`, ORIGIN), method: "POST", body: { data: [{ type: "betaGroups", id: ids.groupId }] } }
  if (operation === "submitBetaReview") return { url: new URL("/v1/betaAppReviewSubmissions", ORIGIN), method: "POST", body: {
    data: { type: "betaAppReviewSubmissions", relationships: { build: { data: build } } },
  } }
  throw new SubmitError("UNSAFE_OPERATION")
}

export function createWriteClient(credentials, fetchImpl = fetch) {
  return async (operation, ids) => {
    const { url, method, body } = writeFor(operation, ids)
    if (![credentials.issuer, credentials.keyId, credentials.privateKey].every(value => typeof value === "string" && value.length)) throw new SubmitError("MISSING_CREDENTIALS")
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url")
    const now = Math.floor(Date.now() / 1000)
    const header = encode({ alg: "ES256", kid: credentials.keyId, typ: "JWT" })
    const payload = encode({ iss: credentials.issuer, iat: now, exp: now + 120, aud: "appstoreconnect-v1" })
    let token
    try {
      token = `${header}.${payload}.${sign("sha256", Buffer.from(`${header}.${payload}`), { key: credentials.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`
    } catch { throw new SubmitError("SIGNING_FAILED") }
    let response
    try {
      response = await fetchImpl(url, { method, redirect: "error", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    } catch { throw new SubmitError("WRITE_RESPONSE_UNKNOWN") }
    const expectedStatus = operation === "updateExistingNativeNotes" ? 200 : operation === "associateExistingGroup" ? 204 : 201
    if (response.status !== expectedStatus) {
      let codes = []
      try { const errors = (await response.json())?.errors; codes = Array.isArray(errors) ? errors.slice(0, 5).map(row => row?.code) : [] } catch {}
      throw new SubmitError("WRITE_HTTP_UNCONFIRMED", response.status, codes)
    }
    return { httpStatus: response.status }
  }
}

export async function submitTestflight45({ get, write, enabled = false, confirmTarget = null, acknowledgeAutoNotify = false, onProgress = async () => {} }) {
  const result = { status: "blocked", target: { bundleId: TARGET.bundleId, version: TARGET.version, build: TARGET.build }, actions: [], lastRead: null,
    notificationPolicy: "preserve-existing-true-on-approval", physicalDeviceAcceptance: "unverified" }
  let verifiedIds = null
  const checkpoint = () => onProgress(structuredClone(result))
  async function refresh() {
    let appId = null
    let buildId = null
    let groupId = null
    let noteId = null
    const receipt = await inspectPreflight(async (...args) => {
      const response = await get(...args)
      if (args[0] === "appMetadata") appId = response.data?.length === 1 ? response.data[0].id : null
      if (args[0] === "targetBuild" && response.data?.length === 1) {
        const build = response.data[0]
        buildId = build.id
        const relation = build.relationships?.betaBuildLocalizations?.data
        const notes = Array.isArray(relation) && Array.isArray(response.included)
          ? response.included.filter(row => row.type === "betaBuildLocalizations" && row.attributes?.locale === "en-US" && relation.some(id => id?.type === "betaBuildLocalizations" && id.id === row.id)) : []
        if (notes.length === 1) noteId = notes[0].id
      }
      if (args[0] === "existingPublicGroup") {
        const groups = Array.isArray(response.data) ? response.data : []
        const match = groups.find(row => row.attributes?.isInternalGroup === false && row.attributes?.publicLinkId === TARGET.invite)
        if (match) groupId = match.id
      }
      return response
    })
    result.lastRead = receipt
    await checkpoint()
    if (receipt.status !== "observed") throw new SubmitError("PREFLIGHT_UNAVAILABLE")
    const ids = { appId, buildId, groupId, noteId, locale: receipt.metadata?.primaryLocale }
    if (![appId, buildId, groupId].every(validId) || ids.locale !== "en-US") throw new SubmitError("INVALID_VERIFIED_IDENTITIES")
    if (receipt.build?.notesInspectionComplete !== true || receipt.build.primaryLocaleNoteRecordCount !== 1
      || receipt.build.primaryLocaleNoteRecordUnique !== true || receipt.build.primaryLocaleNoteRecordExists !== true || !validId(noteId)) throw new SubmitError("PRIMARY_NOTE_RECORD_NOT_UNIQUE")
    if (verifiedIds && Object.keys(ids).some(key => ids[key] !== verifiedIds[key])) throw new SubmitError("VERIFIED_IDENTITIES_CHANGED")
    verifiedIds = ids
    return receipt
  }
  function assertBase(read) {
    const m = read.metadata
    const b = read.build
    const g = read.publicGroup
    if (!m?.reviewContactComplete || !m.reviewLoginComplete || !m.primaryLocaleTestInfoComplete || m.appLocalizationsInspectionComplete !== true || m.allLocaleDescriptionsPresent !== true
      || b?.processingState !== "VALID" || b.expired !== false || b.audience !== "APP_STORE_ELIGIBLE" || !b.encryptionDeclarationPresent
      || b.notesInspectionComplete !== true || typeof b.primaryLocaleNoteRecordBlank !== "boolean"
      || b.primaryLocaleNotesPresent !== !b.primaryLocaleNoteRecordBlank || b.groupAssociationComplete !== true || b.autoNotifyEnabled !== true
      || g?.matchingExternalGroupCount !== 1 || g.enabled !== true || typeof g.targetAssociated !== "boolean") throw new SubmitError("PREREQUISITE_OR_NOTIFICATION_DRIFT")
  }
  function reviewAlreadyStarted(read) {
    if (read.activeVersionReviews?.count > 0) {
      if (!read.activeVersionReviews.targetBuildIncluded) throw new SubmitError("OTHER_VERSION_REVIEW_ACTIVE")
      result.status = "alreadyInReview"
      return true
    }
    if (read.build.externalBuildState === "IN_BETA_TESTING" && read.publicGroup.targetAssociated === true) {
      result.status = "alreadyTesting"
      return true
    }
    if (read.build.externalBuildState !== "READY_FOR_BETA_SUBMISSION") throw new SubmitError("EXTERNAL_STATE_CHANGED")
    return false
  }
  async function mutate(operation) {
    const action = { operation, state: "unconfirmed", httpStatus: null }
    result.actions.push(action)
    await checkpoint()
    const response = await write(operation, verifiedIds)
    const expected = operation === "updateExistingNativeNotes" ? 200 : operation === "associateExistingGroup" ? 204 : 201
    if (response?.httpStatus !== expected) throw new SubmitError("WRITE_RESPONSE_UNKNOWN")
    action.state = "accepted"
    action.httpStatus = expected
    await checkpoint()
  }
  try {
    if (!enabled || confirmTarget !== CONFIRM_TARGET || !acknowledgeAutoNotify) throw new SubmitError("WRITE_NOT_ENABLED")
    result.status = "running"
    await checkpoint()
    let read = await refresh()
    assertBase(read)
    if (reviewAlreadyStarted(read)) return result
    if (read.build.primaryLocaleNoteRecordBlank === true) {
      await mutate("updateExistingNativeNotes")
      read = await refresh()
      assertBase(read)
      if (read.build.primaryLocaleNotesPresent !== true) throw new SubmitError("NOTES_READBACK_UNCONFIRMED")
      if (reviewAlreadyStarted(read)) return result
    }
    if (read.publicGroup.targetAssociated !== true) {
      await mutate("associateExistingGroup")
      read = await refresh()
      assertBase(read)
      if (read.publicGroup.targetAssociated !== true) throw new SubmitError("GROUP_READBACK_UNCONFIRMED")
      if (reviewAlreadyStarted(read)) return result
    }
    if (read.submissionPrerequisitesComplete !== true) throw new SubmitError("SUBMISSION_PREREQUISITES_INCOMPLETE")
    await mutate("submitBetaReview")
    read = await refresh()
    assertBase(read)
    result.status = read.activeVersionReviews?.targetBuildIncluded || ["WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW", "READY_FOR_BETA_TESTING", "IN_BETA_TESTING"].includes(read.build.externalBuildState)
      ? "submitted" : "submissionReadbackUnconfirmed"
  } catch (error) {
    const safe = error instanceof SubmitError ? error : new SubmitError("UNEXPECTED_ERROR")
    result.error = { code: safe.code, httpStatus: safe.httpStatus, errorCodes: safe.errorCodes }
    result.status = result.actions.length ? "partialOrUnconfirmed" : "blocked"
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const credentials = { issuer: process.env.APPLE_API_ISSUER, keyId: process.env.APPLE_API_KEY, privateKey: process.env.APPLE_API_PRIVATE_KEY }
  const exactArgs = args.length === 5 && args[0] === "--confirm-target" && args[1] === CONFIRM_TARGET && args[2] === "--ack-existing-auto-notify" && args[3] === "--out" && typeof args[4] === "string"
  const output = exactArgs ? args[4] : ".ci/testflight45-submit.json"
  await mkdir(dirname(output), { recursive: true })
  const save = async receipt => {
    await writeFile(`${output}.next`, JSON.stringify(receipt, null, 2), { mode: 0o600 })
    await rename(`${output}.next`, output)
  }
  const receipt = await submitTestflight45({ get: createPreflightClient(credentials), write: createWriteClient(credentials),
    enabled: process.env.TESTFLIGHT45_SUBMIT_ALLOWED === "reviewed" && exactArgs, confirmTarget: args[1], acknowledgeAutoNotify: exactArgs,
    onProgress: async value => { await save(value); console.log(JSON.stringify({ checkpoint: value })) } })
  await save(receipt)
  console.log(JSON.stringify(receipt))
  if (!["submitted", "alreadyInReview", "alreadyTesting"].includes(receipt.status)) process.exitCode = 1
}
