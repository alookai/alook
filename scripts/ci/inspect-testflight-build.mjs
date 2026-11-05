import { sign } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"

export const TARGET = Object.freeze({ bundleId: "ai.alook.ios", version: "0.1.64", build: "45", invite: "4fHgVBVF" })
const ORIGIN = "https://api.appstoreconnect.apple.com"
const STAGES = Object.freeze({ "/v1/apps": "apps", "/v1/builds": "builds", "/v1/betaGroups": "groups" })
const safeErrorCodes = values => Array.isArray(values) ? values.slice(0, 5).filter(value => typeof value === "string" && /^[A-Z][A-Z0-9_.]{0,79}$/.test(value)) : []
const PARAMETERS = Object.freeze({
  "filter[bundleId]": "appBundleFilter", "fields[apps]": "appFields", "filter[app]": "appFilter",
  "filter[version]": "buildVersionFilter", include: "includedRelationships", "fields[builds]": "buildFields",
  "fields[preReleaseVersions]": "prereleaseFields", "fields[buildBetaDetails]": "betaDetailFields",
  "filter[builds]": "buildFilter", "fields[betaGroups]": "groupFields", limit: "pageLimit", cursor: "pageCursor",
})
const safeParameters = values => Array.isArray(values) ? [...new Set(values.slice(0, 5).filter(value => Object.values(PARAMETERS).includes(value)))] : []

export class InspectionError extends Error {
  constructor(code, httpStatus = null, requestStage = null, errorCodes = [], errorParameters = []) {
    super(code)
    this.code = code
    this.httpStatus = httpStatus
    this.requestStage = requestStage
    this.errorCodes = safeErrorCodes(errorCodes)
    this.errorParameters = safeParameters(errorParameters)
  }
}

function endpoint(path, parameters) {
  const url = new URL(path, ORIGIN)
  url.search = new URLSearchParams(parameters).toString()
  return url
}

function validateUrl(url) {
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) throw new InspectionError("UNSAFE_URL")
  const allowed = {
    "/v1/apps": { "filter[bundleId]": TARGET.bundleId },
    "/v1/builds": { "filter[version]": TARGET.build },
    "/v1/betaGroups": {},
  }
  const rules = allowed[url.pathname]
  if (!rules || Object.entries(rules).some(([key, value]) => url.searchParams.get(key) !== value)) {
    throw new InspectionError("UNSCOPED_URL")
  }
  if (url.pathname !== "/v1/apps" && !url.searchParams.get("filter[app]")) throw new InspectionError("UNSCOPED_URL")
  if (url.pathname === "/v1/betaGroups" && !url.searchParams.get("filter[builds]")) throw new InspectionError("UNSCOPED_URL")
}

export function createReadToken(credentials, url, now = Math.floor(Date.now() / 1000)) {
  validateUrl(url)
  if (![credentials.issuer, credentials.keyId, credentials.privateKey].every(value => typeof value === "string" && value.length)) {
    throw new InspectionError("MISSING_CREDENTIALS")
  }
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url")
  const header = encode({ alg: "ES256", kid: credentials.keyId, typ: "JWT" })
  const payload = encode({ iss: credentials.issuer, iat: now, exp: now + 120, aud: "appstoreconnect-v1", scope: [`GET ${url.pathname}${url.search}`] })
  try {
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: credentials.privateKey, dsaEncoding: "ieee-p1363" })
    return `${header}.${payload}.${signature.toString("base64url")}`
  } catch {
    throw new InspectionError("SIGNING_FAILED")
  }
}

export function createReadClient(credentials, fetchImpl = fetch) {
  return async url => {
    const token = createReadToken(credentials, url)
    let response
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new InspectionError("TRANSPORT_FAILED", null, STAGES[url.pathname])
    }
    if (!response.ok) {
      let errorCodes = []
      let errorParameters = []
      try {
        const body = await response.json()
        const errors = Array.isArray(body?.errors) ? body.errors.slice(0, 5) : []
        errorCodes = safeErrorCodes(errors.map(error => error?.code))
        errorParameters = safeParameters(errors.map(error => {
          const parameter = error?.source?.parameter
          return typeof parameter === "string" && Object.hasOwn(PARAMETERS, parameter) ? PARAMETERS[parameter] : null
        }))
      } catch {}
      throw new InspectionError("HTTP_FAILED", response.status, STAGES[url.pathname], errorCodes, errorParameters)
    }
    try { return await response.json() } catch { throw new InspectionError("INVALID_JSON") }
  }
}

function onlyOne(rows, code) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new InspectionError(code)
  return rows[0]
}

function state(value) {
  return typeof value === "string" && /^[A-Z_]{1,80}$/.test(value) ? value : "UNKNOWN"
}

function buildObservation(attributes, beta) {
  return {
    processingState: state(attributes?.processingState),
    expired: typeof attributes?.expired === "boolean" ? attributes.expired : null,
    internalBuildState: state(beta?.internalBuildState), externalBuildState: state(beta?.externalBuildState),
  }
}

export async function inspectBuild(get) {
  const apps = await get(endpoint("/v1/apps", { "filter[bundleId]": TARGET.bundleId, "fields[apps]": "bundleId", limit: "2" }))
  const app = onlyOne(apps.data, "APP_NOT_UNIQUE")
  if (app.type !== "apps" || app.attributes?.bundleId !== TARGET.bundleId || !app.id) throw new InspectionError("WRONG_APP")
  const builds = await get(endpoint("/v1/builds", {
    "filter[app]": app.id, "filter[version]": TARGET.build,
    include: "preReleaseVersion,buildBetaDetail",
    "fields[builds]": "version,processingState,expired,uploadedDate,preReleaseVersion,buildBetaDetail",
    "fields[preReleaseVersions]": "version,platform",
    "fields[buildBetaDetails]": "internalBuildState,externalBuildState", limit: "2",
  }))
  const build = onlyOne(builds.data, "BUILD_NOT_UNIQUE")
  if (build.type !== "builds" || build.attributes?.version !== TARGET.build || !build.id) throw new InspectionError("WRONG_BUILD")
  const related = (name, type) => builds.included?.find(row => row.type === type && row.id === build.relationships?.[name]?.data?.id)
  const version = related("preReleaseVersion", "preReleaseVersions")
  if (version?.attributes?.version !== TARGET.version || version?.attributes?.platform !== "IOS") throw new InspectionError("WRONG_PRERELEASE_VERSION")
  const beta = related("buildBetaDetail", "buildBetaDetails")?.attributes
  const observation = buildObservation(build.attributes, beta)
  const groups = new Map()
  let url = endpoint("/v1/betaGroups", {
    "filter[app]": app.id, "filter[builds]": build.id,
    "fields[betaGroups]": "isInternalGroup,publicLinkEnabled,publicLinkId", limit: "200",
  })
  try {
    for (let page = 0; url && page < 5; page++) {
      const result = await get(url)
      if (!Array.isArray(result.data)) throw new InspectionError("INVALID_GROUPS")
      for (const group of result.data) {
        if (group.type !== "betaGroups" || !group.id) throw new InspectionError("INVALID_GROUPS")
        groups.set(group.id, group.attributes ?? {})
      }
      if (!result.links?.next) { url = null; break }
      const next = new URL(result.links.next, ORIGIN)
      validateUrl(next)
      const keys = [...next.searchParams.keys()]
      if (next.pathname !== "/v1/betaGroups" || next.searchParams.get("filter[app]") !== app.id || next.searchParams.get("filter[builds]") !== build.id
        || next.searchParams.get("fields[betaGroups]") !== "isInternalGroup,publicLinkEnabled,publicLinkId"
        || new Set(keys).size !== keys.length || keys.some(key => !["filter[app]", "filter[builds]", "fields[betaGroups]", "limit", "cursor"].includes(key))) {
        throw new InspectionError("UNSAFE_PAGINATION")
      }
      url = next
    }
    if (url) throw new InspectionError("GROUP_PAGINATION_LIMIT")
  } catch (error) {
    const failure = error instanceof InspectionError ? error : new InspectionError("GROUP_INSPECTION_FAILED")
    failure.requestStage ??= "groups"
    failure.buildObservation = observation
    throw failure
  }
  const rows = [...groups.values()]
  const publicGroups = rows.filter(group => group.publicLinkId === TARGET.invite)
  const { processingState, internalBuildState, externalBuildState, expired } = observation
  return {
    status: "observed", target: { bundleId: TARGET.bundleId, version: TARGET.version, build: TARGET.build },
    processingState, expired, internalBuildState, externalBuildState,
    associatedGroupCount: rows.length,
    internalGroupCount: rows.filter(group => group.isInternalGroup === true).length,
    externalGroupCount: rows.filter(group => group.isInternalGroup === false).length,
    publicInviteAssociated: publicGroups.length > 0,
    publicInviteEnabled: publicGroups.length ? publicGroups.some(group => group.publicLinkEnabled === true) : null,
    publicBuildListedAsTesting: processingState === "UNKNOWN" || externalBuildState === "UNKNOWN" || expired === null
      ? null : processingState === "VALID" && !expired && externalBuildState === "IN_BETA_TESTING" && publicGroups.some(group => group.publicLinkEnabled === true && group.isInternalGroup === false),
    physicalDeviceAcceptance: "unverified",
  }
}

export function failureReceipt(error) {
  return { status: "unavailable", target: { bundleId: TARGET.bundleId, version: TARGET.version, build: TARGET.build }, code: error instanceof InspectionError ? error.code : "UNEXPECTED_ERROR", httpStatus: error instanceof InspectionError ? error.httpStatus : null,
    requestStage: error instanceof InspectionError && Object.values(STAGES).includes(error.requestStage) ? error.requestStage : null,
    errorCodes: error instanceof InspectionError ? safeErrorCodes(error.errorCodes) : [],
    errorParameters: error instanceof InspectionError ? safeParameters(error.errorParameters) : [],
    buildObservation: error instanceof InspectionError && error.buildObservation
      ? buildObservation(error.buildObservation, error.buildObservation) : null,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let receipt
  try {
    receipt = await inspectBuild(createReadClient({ issuer: process.env.APPLE_API_ISSUER, keyId: process.env.APPLE_API_KEY, privateKey: process.env.APPLE_API_PRIVATE_KEY }))
  } catch (error) {
    receipt = failureReceipt(error)
    process.exitCode = 1
  }
  const output = process.argv[2] ?? ".ci/testflight45-status.json"
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(receipt, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(receipt))
}
