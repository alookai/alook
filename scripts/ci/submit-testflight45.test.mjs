import assert from "node:assert/strict"
import { generateKeyPairSync, verify } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { CONFIRM_TARGET, NATIVE_TEST_NOTES, createWriteClient, writeFor, SubmitError, submitTestflight45 } from "./submit-testflight45.mjs"
import { createPreflightClient } from "./inspect-testflight-preflight.mjs"

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
const credentials = { issuer: "synthetic-issuer", keyId: "synthetic-key", privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }) }
const identities = { appId: "app-1", buildId: "build-45", groupId: "group-1", noteId: "note-1", locale: "en-US" }
const privateText = "private-user@example.com"
function fixture(initial = {}) {
  const server = { notes: false, noteExists: true, noteId: "note-1", associated: false, review: false, otherReview: false, autoNotify: true, appId: "app-1", contact: true, ...initial }
  const writes = []
  const reads = []
  const get = async stage => {
    reads.push(stage)
    if (stage === "appMetadata") {
      const response = { data: [{ type: "apps", id: server.appId, attributes: { bundleId: "ai.alook.ios", primaryLocale: "en-US" }, relationships: {
        betaAppReviewDetail: { data: { id: "contact-1" } }, betaAppLocalizations: { data: [{ type: "betaAppLocalizations", id: "locale-1" }] },
      } }], included: [
        { type: "betaAppReviewDetails", id: "contact-1", attributes: { contactFirstName: privateText, contactLastName: privateText, contactEmail: privateText, contactPhone: server.contact ? privateText : "", demoAccountRequired: false } },
        { type: "betaAppLocalizations", id: "locale-1", attributes: { locale: "en-US", description: "private-description", feedbackEmail: privateText } },
      ] }
      if (server.secondaryDescriptionEmpty) {
        response.data[0].relationships.betaAppLocalizations.data.push({ type: "betaAppLocalizations", id: "locale-2" })
        response.included.push({ type: "betaAppLocalizations", id: "locale-2", attributes: { locale: "zh-Hans", description: "", feedbackEmail: privateText } })
      }
      if (server.localizationsTruncated) response.data[0].relationships.betaAppLocalizations.meta = { paging: { total: 2 } }
      return response
    }
    if (stage === "existingPublicGroup") return { data: [{ type: "betaGroups", id: "group-1", attributes: { isInternalGroup: false, publicLinkId: "4fHgVBVF", publicLinkEnabled: true } }] }
    const pending = stage === "activeVersionReviews"
    if (pending && !server.review && !server.otherReview) return { data: [] }
    const reviewing = server.review || server.otherReview
    const buildId = pending && server.otherReview ? "other-build" : "build-45"
    return { data: [{ type: "builds", id: buildId, attributes: { version: "45", processingState: "VALID", expired: false, buildAudienceType: "APP_STORE_ELIGIBLE", usesNonExemptEncryption: false }, relationships: {
      preReleaseVersion: { data: { id: "version-1" } }, buildBetaDetail: { data: { id: "beta-1" } },
      betaGroups: { data: server.associated ? [{ type: "betaGroups", id: "group-1" }] : [] },
      betaBuildLocalizations: { data: server.noteExists ? [{ type: "betaBuildLocalizations", id: server.noteId }] : [] },
      ...(reviewing ? { betaAppReviewSubmission: { data: { id: "review-1" } } } : {}),
    } }], included: [
      { type: "preReleaseVersions", id: "version-1", attributes: { version: "0.1.64", platform: "IOS" } },
      { type: "buildBetaDetails", id: "beta-1", attributes: { internalBuildState: "READY_FOR_BETA_TESTING", externalBuildState: server.external ?? (server.review ? "WAITING_FOR_BETA_REVIEW" : "READY_FOR_BETA_SUBMISSION"), autoNotifyEnabled: server.autoNotify } },
      ...(server.noteExists ? [{ type: "betaBuildLocalizations", id: server.noteId, attributes: { locale: "en-US", whatsNew: server.notes ? "private-existing-notes" : "" } }] : []),
      ...(reviewing ? [{ type: "betaAppReviewSubmissions", id: "review-1", attributes: { betaReviewState: "WAITING_FOR_REVIEW" } }] : []),
    ] }
  }
  const write = async (operation, ids) => {
    assert.deepEqual(ids, identities)
    writes.push(operation)
    if (operation === "updateExistingNativeNotes") server.notes = true
    if (operation === "associateExistingGroup") server.associated = true
    if (operation === "submitBetaReview") server.review = true
    return { httpStatus: operation === "updateExistingNativeNotes" ? 200 : operation === "associateExistingGroup" ? 204 : 201 }
  }
  return { get, write, reads, writes, server }
}
const enabled = f => ({ get: f.get, write: f.write, enabled: true, confirmTarget: CONFIRM_TARGET, acknowledgeAutoNotify: true })

export function registerSubmitContracts(test) {
test("write requires explicit enable, exact target and existing-notification acknowledgement before any read or POST", async () => {
  for (const overrides of [{ enabled: false }, { confirmTarget: "other:0.1.64:45" }, { acknowledgeAutoNotify: false }]) {
    const f = fixture()
    const receipt = await submitTestflight45({ ...enabled(f), ...overrides })
    assert.equal(receipt.error.code, "WRITE_NOT_ENABLED")
    assert.equal(f.reads.length, 0)
    assert.equal(f.writes.length, 0)
  }
})

test("allowlisted PATCH and two POSTs have exact methods, fixed native-only text and valid short ES256 tokens", async () => {
  const calls = []
  const write = createWriteClient(credentials, async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) })
    assert.equal(options.method, url.pathname.includes("betaBuildLocalizations/") ? "PATCH" : "POST")
    assert.equal(options.redirect, "error")
    assert.equal(url.origin, "https://api.appstoreconnect.apple.com")
    const [header, payload, signature] = options.headers.Authorization.slice(7).split(".")
    const claims = JSON.parse(Buffer.from(payload, "base64url"))
    assert.equal(claims.exp - claims.iat, 120)
    assert.equal(claims.aud, "appstoreconnect-v1")
    assert.equal("scope" in claims, false)
    assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: keys.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true)
    return { status: options.method === "PATCH" ? 200 : url.pathname.includes("relationships") ? 204 : 201 }
  })
  for (const op of ["updateExistingNativeNotes", "associateExistingGroup", "submitBetaReview"]) await write(op, identities)
  assert.equal(calls[0].url.pathname, "/v1/betaBuildLocalizations/note-1")
  assert.deepEqual(calls[0].body, { data: { type: "betaBuildLocalizations", id: "note-1", attributes: { whatsNew: NATIVE_TEST_NOTES } } })
  assert.equal(calls[0].method, "PATCH")
  assert.match(NATIVE_TEST_NOTES, /iPhone/)
  assert.doesNotMatch(NATIVE_TEST_NOTES, /sticker|Inbox|Mark|fixed|passed/i)
  assert.equal(calls[1].url.pathname, "/v1/builds/build-45/relationships/betaGroups")
  assert.deepEqual(calls[1].body, { data: [{ type: "betaGroups", id: "group-1" }] })
  assert.equal(calls[2].url.pathname, "/v1/betaAppReviewSubmissions")
  assert.deepEqual(calls[2].body, { data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: "build-45" } } } } })
})

test("unknown operations including create, malformed identities and non-en-US locale fail before network", async () => {
  let calls = 0
  const write = createWriteClient(credentials, async () => { calls++ })
  await assert.rejects(write("deleteGroup", identities), /UNSAFE_OPERATION/)
  await assert.rejects(write("createNativeNotes", identities), /UNSAFE_OPERATION/)
  for (const ids of [{ ...identities, buildId: "../../other" }, { ...identities, groupId: null }, { ...identities, locale: "zh-CN" }, { ...identities, noteId: "../foreign" }, { ...identities, noteId: null }]) await assert.rejects(write("submitBetaReview", ids), /INVALID_VERIFIED_IDENTITIES/)
  assert.equal(calls, 0)
  assert.throws(() => writeFor("arbitrary", identities), SubmitError)
  await assert.rejects(createWriteClient({}, async () => { calls++ })("submitBetaReview", identities), /MISSING_CREDENTIALS/)
  await assert.rejects(createWriteClient({ ...credentials, privateKey: privateText }, async () => { calls++ })("submitBetaReview", identities), /SIGNING_FAILED/)
  assert.equal(calls, 0)
})

test("successful sequence re-reads server state between writes and saves pending receipts before each write", async () => {
  const f = fixture()
  let saved = null
  const receipt = await submitTestflight45({ ...enabled(f), onProgress: async value => { saved = value }, write: async (op, ids) => {
    assert.equal(saved.actions.at(-1).operation, op)
    assert.equal(saved.actions.at(-1).state, "unconfirmed")
    assert.equal(f.reads.length, (f.writes.length + 1) * 4)
    return f.write(op, ids)
  } })
  assert.equal(receipt.status, "submitted")
  assert.deepEqual(f.writes, ["updateExistingNativeNotes", "associateExistingGroup", "submitBetaReview"])
  assert.equal(f.reads.length, 16)
  assert.equal(receipt.lastRead.activeVersionReviews.targetBuildIncluded, true)
  assert.equal(receipt.actions.every(row => row.state === "accepted"), true)
  assert.equal(receipt.lastRead.build.autoNotifyEnabled, true)
  for (const value of [privateText, "private-description", "private-existing-notes", "app-1", "build-45", "group-1", "note-1"]) assert.equal(JSON.stringify(receipt).includes(value), false)
})

test("already present notes and association are preserved rather than rewritten", async () => {
  const f = fixture({ notes: true, associated: true })
  assert.equal((await submitTestflight45(enabled(f))).status, "submitted")
  assert.deepEqual(f.writes, ["submitBetaReview"])
})

test("absent, duplicate, unknown or incomplete note records block all writes rather than create or overwrite", async () => {
  const variants = [
    { initial: { noteExists: false } },
    { initial: { noteId: "../invalid" } },
    { change: response => { response.included.find(row => row.type === "betaBuildLocalizations").attributes.whatsNew = undefined } },
    { change: response => { response.data[0].relationships.betaBuildLocalizations.links = { next: "private-next" } } },
    { change: response => {
      response.data[0].relationships.betaBuildLocalizations.data.push({ type: "betaBuildLocalizations", id: "note-2" })
      response.included.push({ type: "betaBuildLocalizations", id: "note-2", attributes: { locale: "en-US", whatsNew: "" } })
    } },
  ]
  for (const variant of variants) {
    const f = fixture(variant.initial)
    const receipt = await submitTestflight45({ ...enabled(f), get: async (...args) => {
      const response = await f.get(...args)
      if (args[0] === "targetBuild" && variant.change) variant.change(response)
      return response
    } })
    assert.equal(receipt.status, "blocked")
    assert.deepEqual(f.writes, [])
    assert.deepEqual(receipt.actions, [])
  }
})

test("unrelated included primary-locale notes cannot steer PATCH away from the exact build relationship", async () => {
  const f = fixture()
  const receipt = await submitTestflight45({ ...enabled(f), get: async (...args) => {
    const response = await f.get(...args)
    if (args[0] === "targetBuild") response.included.unshift({ type: "betaBuildLocalizations", id: "foreign-note", attributes: { locale: "en-US", whatsNew: "" } })
    return response
  } })
  assert.equal(receipt.status, "submitted")
  assert.deepEqual(f.writes, ["updateExistingNativeNotes", "associateExistingGroup", "submitBetaReview"])
  assert.equal(JSON.stringify(receipt).includes("foreign-note"), false)
})

test("verified note ID changing after accepted PATCH stops before group or review writes", async () => {
  const f = fixture()
  const receipt = await submitTestflight45({ ...enabled(f), write: async (...args) => {
    const response = await f.write(...args)
    f.server.noteId = "note-2"
    return response
  } })
  assert.equal(receipt.status, "partialOrUnconfirmed")
  assert.equal(receipt.error.code, "VERIFIED_IDENTITIES_CHANGED")
  assert.deepEqual(f.writes, ["updateExistingNativeNotes"])
  assert.equal(receipt.actions[0].httpStatus, 200)
  assert.equal(JSON.stringify(receipt).includes("note-2"), false)
})

test("applied PATCH with an ambiguous response stays one unconfirmed action and is never replayed", async () => {
  const f = fixture()
  const receipt = await submitTestflight45({ ...enabled(f), write: async (...args) => {
    await f.write(...args)
    throw new SubmitError("WRITE_RESPONSE_UNKNOWN")
  } })
  assert.equal(f.server.notes, true)
  assert.equal(receipt.status, "partialOrUnconfirmed")
  assert.deepEqual(f.writes, ["updateExistingNativeNotes"])
  assert.deepEqual(receipt.actions, [{ operation: "updateExistingNativeNotes", state: "unconfirmed", httpStatus: null }])
  assert.equal(receipt.lastRead.build.primaryLocaleNoteRecordBlank, true)
})

test("same-build pending review skips every mutation, other same-version review blocks every mutation", async () => {
  const target = fixture({ review: true, notes: true, associated: true })
  assert.equal((await submitTestflight45(enabled(target))).status, "alreadyInReview")
  assert.deepEqual(target.writes, [])
  const other = fixture({ otherReview: true })
  assert.equal((await submitTestflight45(enabled(other))).error.code, "OTHER_VERSION_REVIEW_ACTIVE")
  assert.deepEqual(other.writes, [])
})

test("a build already testing in the existing group does not mutate or submit again", async () => {
  const f = fixture({ notes: true, associated: true, external: "IN_BETA_TESTING" })
  assert.equal((await submitTestflight45(enabled(f))).status, "alreadyTesting")
  assert.deepEqual(f.writes, [])
})

test("missing metadata or changed notification policy refuses all writes", async () => {
  for (const initial of [{ contact: false }, { autoNotify: false }]) {
    const f = fixture(initial)
    assert.equal((await submitTestflight45(enabled(f))).error.code, "PREREQUISITE_OR_NOTIFICATION_DRIFT")
    assert.deepEqual(f.writes, [])
  }
})

test("empty secondary-language description or incomplete localization collection blocks before any POST", async () => {
  for (const initial of [{ secondaryDescriptionEmpty: true }, { localizationsTruncated: true }]) {
    const f = fixture(initial)
    const receipt = await submitTestflight45(enabled(f))
    assert.equal(receipt.status, "blocked")
    assert.equal(receipt.error.code, "PREREQUISITE_OR_NOTIFICATION_DRIFT")
    assert.equal(receipt.lastRead.metadata.primaryLocaleTestInfoComplete, true)
    assert.equal(receipt.lastRead.metadata.allLocaleDescriptionsPresent, false)
    assert.deepEqual(f.writes, [])
  }
})

test("completed403 preflight failure returns blocked with zero POSTs instead of a running terminal state", async () => {
  let writes = 0
  const get = createPreflightClient(credentials, async () => ({ ok: false, status: 403, json: async () => ({ errors: [{ code: "FORBIDDEN_ERROR", detail: privateText }] }) }))
  const receipt = await submitTestflight45({ enabled: true, confirmTarget: CONFIRM_TARGET, acknowledgeAutoNotify: true, get, write: async () => { writes++ } })
  assert.equal(receipt.status, "blocked")
  assert.equal(receipt.error.code, "PREFLIGHT_UNAVAILABLE")
  assert.equal(receipt.lastRead.error.httpStatus, 403)
  assert.deepEqual(receipt.actions, [])
  assert.equal(writes, 0)
  assert.equal(JSON.stringify(receipt).includes(privateText), false)
})

test("unconfirmed readback, identity drift and concurrent review stop after the accepted first action", async () => {
  for (const change of [f => { f.server.notes = false }, f => { f.server.appId = "app-2" }, f => { f.server.otherReview = true }, f => { f.server.autoNotify = false }]) {
    const f = fixture()
    const receipt = await submitTestflight45({ ...enabled(f), write: async (...args) => { const r = await f.write(...args); change(f); return r } })
    assert.equal(receipt.status, "partialOrUnconfirmed")
    assert.deepEqual(f.writes, ["updateExistingNativeNotes"])
    assert.equal(receipt.actions[0].state, "accepted")
    assert.equal(receipt.error.code.length > 0, true)
  }
})

test("ambiguous applied submission is never retried and stays unconfirmed in the receipt", async () => {
  const f = fixture()
  const receipt = await submitTestflight45({ ...enabled(f), write: async (...args) => {
    const r = await f.write(...args)
    if (args[0] === "submitBetaReview") throw new SubmitError("WRITE_RESPONSE_UNKNOWN")
    return r
  } })
  assert.equal(f.server.review, true)
  assert.deepEqual(f.writes, ["updateExistingNativeNotes", "associateExistingGroup", "submitBetaReview"])
  assert.equal(receipt.status, "partialOrUnconfirmed")
  assert.equal(receipt.actions.at(-1).state, "unconfirmed")
  assert.equal(receipt.lastRead.activeVersionReviews.count, 0)
})

test("accepted submission with stale readback stays unconfirmed without a second POST", async () => {
  const f = fixture({ notes: true, associated: true })
  const receipt = await submitTestflight45({ ...enabled(f), write: async (...args) => {
    const response = await f.write(...args)
    f.server.review = false
    return response
  } })
  assert.equal(receipt.status, "submissionReadbackUnconfirmed")
  assert.deepEqual(f.writes, ["submitBetaReview"])
  assert.equal(receipt.actions[0].state, "accepted")
  assert.equal(receipt.lastRead.build.externalBuildState, "READY_FOR_BETA_SUBMISSION")
})

test("HTTP and network errors on PATCH and POST retain safe status/codes and do not retry", async () => {
  for (const operation of ["updateExistingNativeNotes", "submitBetaReview"]) for (const status of [...(operation === "updateExistingNativeNotes" ? [201, 204] : [200, 204]), 302, 403, 409, 500]) {
    let calls = 0
    const write = createWriteClient(credentials, async () => { calls++; return { status, json: async () => ({ errors: [{ code: "ENTITY_ERROR", detail: credentials.privateKey, source: { parameter: privateText } }, { code: privateText }] }) } })
    await assert.rejects(write(operation, identities), error => {
      assert.equal(error.httpStatus, status)
      assert.deepEqual(error.errorCodes, ["ENTITY_ERROR"])
      assert.equal(error.message.includes(privateText), false)
      return true
    })
    assert.equal(calls, 1)
  }
  let calls = 0
  const write = createWriteClient(credentials, async () => { calls++; throw new Error(credentials.privateKey) })
  await assert.rejects(write("submitBetaReview", identities), /WRITE_RESPONSE_UNKNOWN/)
  assert.equal(calls, 1)
})

test("failure to save the pending checkpoint prevents POST and does not echo disk exception text", async () => {
  const f = fixture()
  const receipt = await submitTestflight45({ ...enabled(f), onProgress: async value => { if (value.actions.length) throw new Error(privateText) } })
  assert.deepEqual(f.writes, [])
  assert.equal(receipt.error.code, "UNEXPECTED_ERROR")
  assert.equal(JSON.stringify(receipt).includes(privateText), false)
})

test("real CLI default-off and reviewed-but-missing-credential paths write safe atomic receipts without network", () => {
  const dir = mkdtempSync(join(tmpdir(), "alook-tf-submit-"))
  try {
    const env = { ...process.env }
    for (const key of ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_PRIVATE_KEY", "TESTFLIGHT45_SUBMIT_ALLOWED"]) delete env[key]
    const script = fileURLToPath(new URL("./submit-testflight45.mjs", import.meta.url))
    const disabled = spawnSync(process.execPath, [script], { cwd: dir, env, encoding: "utf8" })
    assert.equal(disabled.status, 1)
    assert.equal(disabled.stderr, "")
    assert.equal(JSON.parse(disabled.stdout).error.code, "WRITE_NOT_ENABLED")
    const out = join(dir, "enabled.json")
    const run = spawnSync(process.execPath, [script, "--confirm-target", CONFIRM_TARGET, "--ack-existing-auto-notify", "--out", out], { cwd: dir, env: { ...env, TESTFLIGHT45_SUBMIT_ALLOWED: "reviewed" }, encoding: "utf8" })
    assert.equal(run.status, 1)
    assert.equal(run.stderr, "")
    const receipt = JSON.parse(readFileSync(out, "utf8"))
    assert.equal(receipt.status, "blocked")
    assert.equal(receipt.error.code, "PREFLIGHT_UNAVAILABLE")
    assert.equal(receipt.lastRead.error.code, "MISSING_CREDENTIALS")
    assert.deepEqual(receipt.actions, [])
    if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) registerSubmitContracts((await import("node:test")).default)
