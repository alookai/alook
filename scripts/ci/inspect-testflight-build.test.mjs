import { pathToFileURL } from "node:url"
import assert from "node:assert/strict"
import { generateKeyPairSync, verify } from "node:crypto"
import { createReadClient, createReadToken, failureReceipt, inspectBuild, InspectionError, TARGET } from "./inspect-testflight-build.mjs"

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
const credentials = { issuer: "synthetic-issuer", keyId: "synthetic-key", privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }) }
const apps = { data: [{ type: "apps", id: "app-1", attributes: { bundleId: TARGET.bundleId } }] }
const builds = {
  data: [{ type: "builds", id: "build-45", attributes: { version: "45", processingState: "VALID", expired: false }, relationships: {
    preReleaseVersion: { data: { id: "version-1" } }, buildBetaDetail: { data: { id: "detail-1" } },
  } }],
  included: [
    { type: "preReleaseVersions", id: "version-1", attributes: { version: "0.1.64", platform: "IOS" } },
    { type: "buildBetaDetails", id: "detail-1", attributes: { internalBuildState: "IN_BETA_TESTING", externalBuildState: "IN_BETA_TESTING" } },
  ],
}
const publicGroup = { type: "betaGroups", id: "private-group-id", attributes: { name: "private group name", isInternalGroup: false, publicLinkEnabled: true, publicLinkId: TARGET.invite } }

function fixtures(overrides = {}) {
  const calls = []
  const get = async url => {
    calls.push(url)
    if (url.pathname === "/v1/apps") return structuredClone(overrides.apps ?? apps)
    if (url.pathname === "/v1/builds") {
      assert.equal(url.searchParams.get("filter[app]"), "app-1")
      assert.equal(url.searchParams.get("filter[version]"), "45")
      return structuredClone(overrides.builds ?? builds)
    }
    assert.equal(url.pathname, "/v1/betaGroups")
    assert.equal(url.searchParams.get("filter[app]"), "app-1")
    assert.equal(url.searchParams.get("filter[builds]"), "build-45")
    return structuredClone(overrides.groups ?? { data: [publicGroup] })
  }
  return { get, calls }
}

export function registerContracts(test) {
test("ES256 signature verifies and token scope contains one exact GET with120s lifetime", () => {
  const url = new URL("https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=ai.alook.ios")
  const token = createReadToken(credentials, url, 1000)
  const [header, payload, signature] = token.split(".")
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "ES256", kid: credentials.keyId, typ: "JWT" })
  const claims = JSON.parse(Buffer.from(payload, "base64url"))
  assert.deepEqual(claims, { iss: credentials.issuer, iat: 1000, exp: 1120, aud: "appstoreconnect-v1", scope: [`GET ${url.pathname}${url.search}`] })
  assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: keys.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true)
})

test("client only sends GET, blocks redirect and omits raw failed response bodies", async () => {
  let calls = 0
  const get = createReadClient(credentials, async (_url, options) => {
    calls++
    assert.equal(options.method, "GET")
    assert.equal(options.redirect, "error")
    return { ok: false, status: 403, json() { throw new Error("raw tester or credential data must not be read") } }
  })
  await assert.rejects(get(new URL("https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=ai.alook.ios")), error => {
    assert.deepEqual(failureReceipt(error), { status: "unavailable", target: { bundleId: TARGET.bundleId, version: TARGET.version, build: "45" }, code: "HTTP_FAILED", httpStatus: 403 })
    return true
  })
  assert.equal(calls, 1)
})

test("foreign origins and unscoped paths are rejected before fetch", async () => {
  let calls = 0
  const get = createReadClient(credentials, async () => { calls++; throw new Error("must not fetch") })
  for (const url of ["https://example.com/v1/apps?filter[bundleId]=ai.alook.ios", "https://api.appstoreconnect.apple.com/v1/users", "https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=other", "https://api.appstoreconnect.apple.com/v1/betaGroups"]) {
    await assert.rejects(get(new URL(url)), InspectionError)
  }
  assert.equal(calls, 0)
})

test("public testing receipt requires the exact45 build association and excludes private metadata", async () => {
  const { get, calls } = fixtures()
  const report = await inspectBuild(get)
  assert.equal(calls.length, 3)
  assert.equal(report.processingState, "VALID")
  assert.equal(report.publicInviteAssociated, true)
  assert.equal(report.publicBuildListedAsTesting, true)
  assert.equal(report.physicalDeviceAcceptance, "unverified")
  const serialized = JSON.stringify(report)
  for (const privateValue of ["private group name", "private-group-id", "app-1", "build-45", credentials.keyId, credentials.privateKey]) assert.equal(serialized.includes(privateValue), false)
})

test("no group and pending beta detail are distinct from a ready public build", async () => {
  const noGroup = await inspectBuild(fixtures({ groups: { data: [] } }).get)
  assert.equal(noGroup.publicInviteAssociated, false)
  assert.equal(noGroup.publicBuildListedAsTesting, false)
  const pending = structuredClone(builds)
  pending.included.pop()
  const unknown = await inspectBuild(fixtures({ builds: pending }).get)
  assert.equal(unknown.externalBuildState, "UNKNOWN")
  assert.equal(unknown.publicBuildListedAsTesting, null)
})

test("expired, disabled-public-link and non-testing external state never count as ready", async () => {
  const expired = structuredClone(builds)
  expired.data[0].attributes.expired = true
  assert.equal((await inspectBuild(fixtures({ builds: expired }).get)).publicBuildListedAsTesting, false)
  const disabled = structuredClone(publicGroup)
  disabled.attributes.publicLinkEnabled = false
  assert.equal((await inspectBuild(fixtures({ groups: { data: [disabled] } }).get)).publicBuildListedAsTesting, false)
  const notTesting = structuredClone(builds)
  notTesting.included[1].attributes.externalBuildState = "READY_FOR_BETA_TESTING"
  assert.equal((await inspectBuild(fixtures({ builds: notTesting }).get)).publicBuildListedAsTesting, false)
})

test("wrong app, ambiguous build and wrong prerelease fail closed", async () => {
  const wrongApp = structuredClone(apps)
  wrongApp.data[0].attributes.bundleId = "other"
  await assert.rejects(inspectBuild(fixtures({ apps: wrongApp }).get), /WRONG_APP/)
  const ambiguous = structuredClone(builds)
  ambiguous.data.push(structuredClone(ambiguous.data[0]))
  await assert.rejects(inspectBuild(fixtures({ builds: ambiguous }).get), /BUILD_NOT_UNIQUE/)
  const wrongVersion = structuredClone(builds)
  wrongVersion.included[0].attributes.version = "0.1.63"
  await assert.rejects(inspectBuild(fixtures({ builds: wrongVersion }).get), /WRONG_PRERELEASE_VERSION/)
})

test("pagination cannot change host, target or include tester information", async () => {
  const base = new URL("https://api.appstoreconnect.apple.com/v1/betaGroups")
  base.search = new URLSearchParams({ "filter[app]": "app-1", "filter[builds]": "build-45", "fields[betaGroups]": "isInternalGroup,publicLinkEnabled,publicLinkId", cursor: "next" }).toString()
  for (const mutate of [url => { url.hostname = "example.com" }, url => { url.searchParams.set("filter[builds]", "other") }, url => { url.searchParams.set("include", "betaTesters") }]) {
    const next = new URL(base)
    mutate(next)
    const { get, calls } = fixtures({ groups: { data: [], links: { next: String(next) } } })
    await assert.rejects(inspectBuild(get), InspectionError)
    assert.equal(calls.length, 3)
  }
})

test("scoped pagination completes and repeated group IDs do not inflate the receipt", async () => {
  const { get: original } = fixtures()
  let pages = 0
  const next = new URL("https://api.appstoreconnect.apple.com/v1/betaGroups")
  next.search = new URLSearchParams({ "filter[app]": "app-1", "filter[builds]": "build-45", "fields[betaGroups]": "isInternalGroup,publicLinkEnabled,publicLinkId", cursor: "next" }).toString()
  const report = await inspectBuild(async url => {
    if (url.pathname !== "/v1/betaGroups") return original(url)
    pages++
    return { data: [publicGroup], links: { next: pages === 1 ? String(next) : null } }
  })
  assert.equal(pages, 2)
  assert.equal(report.associatedGroupCount, 1)
  assert.equal(report.publicBuildListedAsTesting, true)
})

test("pagination is bounded and never converts a truncated collection into no groups", async () => {
  const next = new URL("https://api.appstoreconnect.apple.com/v1/betaGroups")
  next.search = new URLSearchParams({ "filter[app]": "app-1", "filter[builds]": "build-45", "fields[betaGroups]": "isInternalGroup,publicLinkEnabled,publicLinkId", cursor: "next" }).toString()
  const { get, calls } = fixtures({ groups: { data: [], links: { next: String(next) } } })
  await assert.rejects(inspectBuild(get), /GROUP_PAGINATION_LIMIT/)
  assert.equal(calls.length, 7)
})

test("unexpected error text is never included in the failure receipt", () => {
  assert.equal(JSON.stringify(failureReceipt(new Error(credentials.privateKey))).includes("PRIVATE KEY"), false)
})

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  registerContracts((await import("node:test")).default)
}
