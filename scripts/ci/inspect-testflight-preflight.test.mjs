import assert from "node:assert/strict"
import { generateKeyPairSync, verify } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createPreflightClient, inspectPreflight, nextCursor, PreflightError, queryFor } from "./inspect-testflight-preflight.mjs"

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
const credentials = { issuer: "synthetic-issuer", keyId: "synthetic-key", privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }) }
const privateText = "private-user@example.com"
const apps = { data: [{ type: "apps", id: "app-1", attributes: { bundleId: "ai.alook.ios", primaryLocale: "en-US" }, relationships: {
  betaAppReviewDetail: { data: { id: "detail-1" } }, betaAppLocalizations: { data: [{ type: "betaAppLocalizations", id: "local-1" }] },
} }], included: [
  { type: "betaAppReviewDetails", id: "detail-1", attributes: { contactFirstName: privateText, contactLastName: privateText, contactEmail: privateText, contactPhone: privateText, demoAccountRequired: true, demoAccountName: privateText, demoAccountPassword: "private-password" } },
  { type: "betaAppLocalizations", id: "local-1", attributes: { locale: "en-US", description: "private-description", feedbackEmail: privateText } },
] }
const builds = { data: [{ type: "builds", id: "build-45", attributes: { version: "45", processingState: "VALID", expired: false, buildAudienceType: "APP_STORE_ELIGIBLE", usesNonExemptEncryption: false }, relationships: {
  preReleaseVersion: { data: { id: "version-1" } }, buildBetaDetail: { data: { id: "beta-1" } },
  betaGroups: { data: [{ type: "betaGroups", id: "group-1" }] }, betaBuildLocalizations: { data: [{ type: "betaBuildLocalizations", id: "note-1" }] },
} }], included: [
  { type: "preReleaseVersions", id: "version-1", attributes: { version: "0.1.64", platform: "IOS" } },
  { type: "buildBetaDetails", id: "beta-1", attributes: { internalBuildState: "READY_FOR_BETA_TESTING", externalBuildState: "READY_FOR_BETA_SUBMISSION", autoNotifyEnabled: false } },
  { type: "betaBuildLocalizations", id: "note-1", attributes: { locale: "en-US", whatsNew: "private-notes" } },
] }
const groups = { data: [{ type: "betaGroups", id: "group-1", attributes: { isInternalGroup: false, publicLinkId: "4fHgVBVF", publicLinkEnabled: true, name: "private-group-name" } }] }
function fixtures(overrides = {}) {
  const calls = []
  const get = async (stage, appId, cursor) => {
    calls.push({ stage, appId, cursor })
    if (stage !== "appMetadata") assert.equal(appId, "app-1")
    return structuredClone(overrides[stage] ?? ({ appMetadata: apps, targetBuild: builds, existingPublicGroup: groups, activeVersionReviews: { data: [] } })[stage])
  }
  return { get, calls }
}
const changed = (value, modify) => { const copy = structuredClone(value); modify(copy); return copy }

export function registerPreflightContracts(test) {
test("four request families use signed exact GET scopes with short lifetimes and fixed app/version filters", async () => {
  const get = createPreflightClient(credentials, async (url, options) => {
    assert.equal(options.method, "GET")
    assert.equal(options.redirect, "error")
    assert.equal(url.origin, "https://api.appstoreconnect.apple.com")
    const [header, payload, signature] = options.headers.Authorization.slice(7).split(".")
    const claims = JSON.parse(Buffer.from(payload, "base64url"))
    assert.equal(claims.exp - claims.iat, 120)
    assert.equal(claims.aud, "appstoreconnect-v1")
    assert.deepEqual(claims.scope, [`GET ${url.pathname}${url.search}`])
    assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: keys.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true)
    return { ok: true, json: async () => ({ data: [] }) }
  })
  await get("appMetadata")
  for (const stage of ["targetBuild", "existingPublicGroup", "activeVersionReviews"]) {
    await get(stage, "app-1")
    const q = queryFor(stage, "app-1")
    assert.equal(q.searchParams.get("filter[app]"), "app-1")
    assert.equal(q.searchParams.has("filter[builds]"), false)
    if (stage !== "existingPublicGroup") assert.equal(q.searchParams.get("filter[preReleaseVersion.version]"), "0.1.64")
  }
  assert.equal(queryFor("targetBuild", "app-1").searchParams.get("filter[version]"), "45")
  assert.equal(queryFor("activeVersionReviews", "app-1").searchParams.has("filter[version]"), false)
})

test("unknown stages, malformed app IDs, unsafe cursors and missing credentials fail before fetch", async () => {
  let calls = 0
  const get = createPreflightClient(credentials, async () => { calls++; throw new Error("must not fetch") })
  for (const args of [["foreign"], ["targetBuild", "../other"], ["targetBuild", null], ["appMetadata", null, "cursor"], ["existingPublicGroup", "app-1", "A".repeat(2049)]]) await assert.rejects(get(...args), PreflightError)
  await assert.rejects(createPreflightClient({}, async () => { calls++ })("appMetadata"), /MISSING_CREDENTIALS/)
  assert.equal(calls, 0)
})

test("pagination preserves origin, app, version, fields and duplicate-key boundaries", () => {
  const base = queryFor("activeVersionReviews", "app-1", "next")
  assert.equal(nextCursor(String(base), "activeVersionReviews", "app-1"), "next")
  for (const mutate of [u => { u.hostname = "example.com" }, u => { u.username = "secret" }, u => { u.searchParams.set("filter[app]", "other") }, u => { u.searchParams.set("include", "betaTesters") }, u => { u.searchParams.append("cursor", "duplicate") }, u => { u.hash = "private" }]) {
    const url = new URL(base); mutate(url)
    assert.throws(() => nextCursor(String(url), "activeVersionReviews", "app-1"), PreflightError)
  }
})

test("complete fixture emits only safe flags and leaves all private metadata and IDs out", async () => {
  const { get, calls } = fixtures()
  const receipt = await inspectPreflight(get)
  assert.equal(calls.length, 4)
  assert.equal(receipt.status, "observed")
  assert.equal(receipt.submissionPrerequisitesComplete, true)
  assert.equal(receipt.build.autoNotifyEnabled, false)
  assert.deepEqual(receipt.publicGroup, { matchingExternalGroupCount: 1, enabled: true, targetAssociated: true })
  const text = JSON.stringify(receipt)
  for (const secret of [privateText, "private-password", "private-description", "private-notes", "private-group-name", "app-1", "build-45", "group-1", credentials.privateKey]) assert.equal(text.includes(secret), false)
})

test("missing contact, reviewer login, localized test info or notes never counts as complete", async () => {
  const missing = changed(apps, x => { x.included[0].attributes.contactPhone = ""; x.included[0].attributes.demoAccountPassword = ""; x.included[1].attributes.feedbackEmail = "" })
  const noNotes = changed(builds, x => { x.included[2].attributes.whatsNew = "" })
  const receipt = await inspectPreflight(fixtures({ appMetadata: missing, targetBuild: noNotes }).get)
  assert.equal(receipt.metadata.reviewContactComplete, false)
  assert.equal(receipt.metadata.reviewLoginComplete, false)
  assert.equal(receipt.metadata.primaryLocaleTestInfoComplete, false)
  assert.equal(receipt.build.primaryLocaleNotesPresent, false)
  assert.equal(receipt.submissionPrerequisitesComplete, false)
  const invalidLocale = changed(apps, x => { x.data[0].attributes.primaryLocale = privateText; x.included[1].attributes.locale = null })
  const nullLocaleNotes = changed(builds, x => { x.included[2].attributes.locale = null })
  const invalid = await inspectPreflight(fixtures({ appMetadata: invalidLocale, targetBuild: nullLocaleNotes }).get)
  assert.equal(invalid.metadata.primaryLocale, null)
  assert.equal(invalid.metadata.primaryLocaleTestInfoComplete, false)
  assert.equal(invalid.build.primaryLocaleNotesPresent, null)
  assert.equal(invalid.build.primaryLocaleNoteRecordCount, null)
  assert.equal(invalid.submissionPrerequisitesComplete, false)
})

test("non-primary beta localization with empty description blocks submission despite complete primary locale", async () => {
  const secondary = changed(apps, x => {
    x.data[0].relationships.betaAppLocalizations.data.push({ type: "betaAppLocalizations", id: "local-2" })
    x.included.push({ type: "betaAppLocalizations", id: "local-2", attributes: { locale: "zh-Hans", description: "  ", feedbackEmail: privateText } })
  })
  const receipt = await inspectPreflight(fixtures({ appMetadata: secondary }).get)
  assert.equal(receipt.metadata.primaryLocaleTestInfoComplete, true)
  assert.equal(receipt.metadata.appLocalizationsInspectionComplete, true)
  assert.equal(receipt.metadata.allLocaleDescriptionsPresent, false)
  assert.equal(receipt.submissionPrerequisitesComplete, false)
  assert.equal(JSON.stringify(receipt).includes(privateText), false)
})

test("truncated or missing included beta localizations cannot claim all-language completeness", async () => {
  for (const incomplete of [
    changed(apps, x => { x.data[0].relationships.betaAppLocalizations.links = { next: "private-next" } }),
    changed(apps, x => { x.data[0].relationships.betaAppLocalizations.meta = { paging: { total: 2 } } }),
    changed(apps, x => { x.data[0].relationships.betaAppLocalizations.data.push({ type: "betaAppLocalizations", id: "missing-included" }) }),
  ]) {
    const receipt = await inspectPreflight(fixtures({ appMetadata: incomplete }).get)
    assert.equal(receipt.metadata.primaryLocaleTestInfoComplete, true)
    assert.equal(receipt.metadata.appLocalizationsInspectionComplete, false)
    assert.equal(receipt.metadata.allLocaleDescriptionsPresent, false)
    assert.equal(receipt.submissionPrerequisitesComplete, false)
  }
})

test("partial group/notes relationships stay unknown; group duplicates and disabled links do not count as ready", async () => {
  const truncated = changed(builds, x => { x.data[0].relationships.betaGroups = { data: [], meta: { paging: { total: 1 } } }; x.data[0].relationships.betaBuildLocalizations = { data: [], links: { next: "private-next" } } })
  const partial = await inspectPreflight(fixtures({ targetBuild: truncated }).get)
  assert.equal(partial.build.groupAssociationComplete, false)
  assert.equal(partial.build.associatedGroupCount, null)
  assert.equal(partial.publicGroup.targetAssociated, null)
  assert.equal(partial.build.primaryLocaleNotesPresent, null)
  const duplicates = changed(groups, x => { x.data.push({ ...x.data[0], id: "group-2" }) })
  assert.equal((await inspectPreflight(fixtures({ existingPublicGroup: duplicates }).get)).publicGroup.enabled, null)
  const disabled = changed(groups, x => { x.data[0].attributes.publicLinkEnabled = false })
  assert.equal((await inspectPreflight(fixtures({ existingPublicGroup: disabled }).get)).submissionPrerequisitesComplete, false)
})

test("primary note records distinguish absence, blank values, nonempty text and unknown attributes without exposing values", async () => {
  const absent = changed(builds, x => { x.data[0].relationships.betaBuildLocalizations.data = []; x.included = x.included.filter(row => row.type !== "betaBuildLocalizations") })
  const absentReceipt = await inspectPreflight(fixtures({ targetBuild: absent }).get)
  assert.equal(absentReceipt.build.notesInspectionComplete, true)
  assert.equal(absentReceipt.build.primaryLocaleNoteRecordCount, 0)
  assert.equal(absentReceipt.build.primaryLocaleNoteRecordExists, false)
  assert.equal(absentReceipt.build.primaryLocaleNoteRecordUnique, false)
  assert.equal(absentReceipt.build.primaryLocaleNoteRecordBlank, null)
  for (const value of ["", "  ", null, "private-notes", undefined, 42]) {
    const note = changed(builds, x => { x.included[2].attributes.whatsNew = value })
    const receipt = await inspectPreflight(fixtures({ targetBuild: note }).get)
    assert.equal(receipt.build.notesInspectionComplete, true)
    assert.equal(receipt.build.primaryLocaleNoteRecordCount, 1)
    assert.equal(receipt.build.primaryLocaleNoteRecordExists, true)
    assert.equal(receipt.build.primaryLocaleNoteRecordUnique, true)
    assert.equal(receipt.build.primaryLocaleNoteRecordBlank, value === null || typeof value === "string" ? !(typeof value === "string" && value.trim().length) : null)
    for (const secret of ["note-1", "private-notes", privateText]) assert.equal(JSON.stringify(receipt).includes(secret), false)
  }
})

test("two primary-locale records remain nonunique even when one is nonempty; unrelated locale rows are excluded", async () => {
  const duplicateLocale = changed(builds, x => {
    x.data[0].relationships.betaBuildLocalizations.data.push({ type: "betaBuildLocalizations", id: "note-2" })
    x.included.push({ type: "betaBuildLocalizations", id: "note-2", attributes: { locale: "en-US", whatsNew: "" } })
  })
  const ambiguous = await inspectPreflight(fixtures({ targetBuild: duplicateLocale }).get)
  assert.equal(ambiguous.build.notesInspectionComplete, true)
  assert.equal(ambiguous.build.primaryLocaleNoteRecordCount, 2)
  assert.equal(ambiguous.build.primaryLocaleNoteRecordExists, true)
  assert.equal(ambiguous.build.primaryLocaleNoteRecordUnique, false)
  assert.equal(ambiguous.build.primaryLocaleNoteRecordBlank, null)
  const secondary = changed(duplicateLocale, x => { x.included.at(-1).attributes.locale = "zh-Hans" })
  const unique = await inspectPreflight(fixtures({ targetBuild: secondary }).get)
  assert.equal(unique.build.primaryLocaleNoteRecordCount, 1)
  assert.equal(unique.build.primaryLocaleNoteRecordUnique, true)
  assert.equal(unique.build.primaryLocaleNoteRecordBlank, false)
})

test("invalid, duplicate or incomplete note relationships cannot produce definitive record counts", async () => {
  const malformed = [
    x => { x.data[0].relationships.betaBuildLocalizations.data.push({ ...x.data[0].relationships.betaBuildLocalizations.data[0] }) },
    x => { x.included.push(structuredClone(x.included[2])) },
    x => { x.data[0].relationships.betaBuildLocalizations.data[0].type = "other" },
    x => { x.data[0].relationships.betaBuildLocalizations.data[0].id = "../other"; x.included[2].id = "../other" },
    x => { x.included[2].attributes.locale = privateText },
    x => { delete x.included[2].attributes.locale },
    x => { x.data[0].relationships.betaBuildLocalizations.links = { next: "private-next" } },
    x => { x.data[0].relationships.betaBuildLocalizations.meta = { paging: { total: 2 } } },
    x => { x.included.pop() },
  ]
  for (const mutate of malformed) {
    const receipt = await inspectPreflight(fixtures({ targetBuild: changed(builds, mutate) }).get)
    assert.equal(receipt.build.notesInspectionComplete, false)
    for (const field of ["primaryLocaleNoteRecordCount", "primaryLocaleNoteRecordExists", "primaryLocaleNoteRecordUnique", "primaryLocaleNoteRecordBlank"]) assert.equal(receipt.build[field], null)
  }
})

test("wrong bundle, ambiguous build or wrong prerelease stops before broader reads", async () => {
  const wrongApp = fixtures({ appMetadata: changed(apps, x => { x.data[0].attributes.bundleId = "other" }) })
  assert.equal((await inspectPreflight(wrongApp.get)).build, null)
  assert.equal(wrongApp.calls.length, 1)
  for (const bad of [changed(builds, x => { x.data.push(x.data[0]) }), changed(builds, x => { x.included[0].attributes.platform = "MAC_OS" }), changed(builds, x => { x.data[0].attributes.version = "44" }), changed(builds, x => { x.data[0].id = {} })]) {
    const { get, calls } = fixtures({ targetBuild: bad })
    const receipt = await inspectPreflight(get)
    assert.equal(receipt.status, "unavailable")
    assert.equal(receipt.build, null)
    assert.equal(calls.length, 2)
  }
})

test("same-version review prevents duplicate submission; off-version or unexpected state is unavailable", async () => {
  const pending = changed(builds, x => {
    x.data[0].id = "other-build"
    x.data[0].relationships.betaAppReviewSubmission = { data: { id: "review-1" } }
    x.included.push({ type: "betaAppReviewSubmissions", id: "review-1", attributes: { betaReviewState: "IN_REVIEW" } })
  })
  const receipt = await inspectPreflight(fixtures({ activeVersionReviews: pending }).get)
  assert.deepEqual(receipt.activeVersionReviews, { count: 1, targetBuildIncluded: false })
  assert.equal(receipt.submissionPrerequisitesComplete, false)
  for (const bad of [changed(pending, x => { x.included[0].attributes.version = "0.1.63" }), changed(pending, x => { x.included.at(-1).attributes.betaReviewState = "APPROVED" })]) {
    const report = await inspectPreflight(fixtures({ activeVersionReviews: bad }).get)
    assert.equal(report.status, "unavailable")
    assert.equal(report.activeVersionReviews, null)
  }
})

test("unbounded or incomplete group/review collections never report zero or ready", async () => {
  for (const stage of ["existingPublicGroup", "activeVersionReviews"]) {
    const response = { data: [], links: { next: String(queryFor(stage, "app-1", "next")) } }
    const fixture = fixtures({ [stage]: response })
    const receipt = await inspectPreflight(fixture.get)
    assert.equal(receipt.status, "unavailable")
    assert.equal(receipt.error.code, "PAGINATION_LIMIT")
    assert.equal(fixture.calls.filter(call => call.stage === stage).length, 5)
    const incomplete = await inspectPreflight(fixtures({ [stage]: { data: [], meta: { paging: { total: 1 } } } }).get)
    assert.equal(incomplete.error.code, "INCOMPLETE_COLLECTION")
  }
})

test("HTTP failure preserves completed safe build evidence and only fixed error metadata", async () => {
  const original = fixtures().get
  const get = createPreflightClient(credentials, async url => {
    if (url.pathname === "/v1/betaGroups") return { ok: false, status: 400, json: async () => ({ errors: [{ code: "PARAMETER_ERROR.INVALID", source: { parameter: "fields[betaGroups]", pointer: privateText }, detail: credentials.privateKey }, { code: privateText, source: { parameter: privateText } }] }) }
    const stage = url.pathname === "/v1/apps" ? "appMetadata" : url.searchParams.has("filter[version]") ? "targetBuild" : "activeVersionReviews"
    return { ok: true, json: () => original(stage, stage === "appMetadata" ? null : "app-1") }
  })
  const receipt = await inspectPreflight(get)
  assert.equal(receipt.status, "unavailable")
  assert.equal(receipt.build.processingState, "VALID")
  assert.equal(receipt.publicGroup, null)
  assert.deepEqual(receipt.error, { code: "HTTP_FAILED", stage: "existingPublicGroup", httpStatus: 400, errorCodes: ["PARAMETER_ERROR.INVALID"], errorParameters: ["groupFields"] })
  assert.equal(JSON.stringify(receipt).includes(privateText), false)
  assert.equal(JSON.stringify(receipt).includes("PRIVATE KEY"), false)
})

test("network, invalid JSON, signing and unexpected failures cannot echo private exception text", async () => {
  for (const fetchImpl of [async () => { throw new Error(credentials.privateKey) }, async () => ({ ok: true, json: () => { throw new Error(privateText) } }), async () => ({ ok: false, status: 403, json: () => { throw new Error(privateText) } })]) {
    const receipt = await inspectPreflight(createPreflightClient(credentials, fetchImpl))
    assert.equal(receipt.status, "unavailable")
    for (const value of [privateText, credentials.privateKey]) assert.equal(JSON.stringify(receipt).includes(value), false)
  }
  const badKey = await inspectPreflight(createPreflightClient({ ...credentials, privateKey: privateText }))
  assert.equal(badKey.error.code, "SIGNING_FAILED")
  const unknown = await inspectPreflight(async () => { throw new Error(privateText) })
  assert.equal(unknown.error.code, "UNEXPECTED_ERROR")
})

test("real CLI without credentials exits1, writes0600 safe partial JSON and empty stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "alook-tf-preflight-"))
  try {
    const env = { ...process.env }
    for (const name of ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_PRIVATE_KEY"]) delete env[name]
    const out = join(dir, "receipt.json")
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("./inspect-testflight-preflight.mjs", import.meta.url)), out], { env, encoding: "utf8" })
    assert.equal(run.status, 1)
    assert.equal(run.stderr, "")
    const receipt = JSON.parse(readFileSync(out, "utf8"))
    assert.equal(receipt.error.code, "MISSING_CREDENTIALS")
    assert.equal(receipt.build, null)
    if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) registerPreflightContracts((await import("node:test")).default)
