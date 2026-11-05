import { sign } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import { TARGET } from "./inspect-testflight-build.mjs"

const ORIGIN = "https://api.appstoreconnect.apple.com"
const STAGES = ["appMetadata", "targetBuild", "existingPublicGroup", "activeVersionReviews"]
const GROUP_FIELDS = "isInternalGroup,publicLinkEnabled,publicLinkId"
const PARAMETERS = Object.freeze({
  "filter[bundleId]": "bundleFilter", "filter[app]": "appFilter", "filter[version]": "buildFilter",
  "filter[preReleaseVersion.version]": "versionFilter", "filter[preReleaseVersion.platform]": "platformFilter",
  "filter[betaAppReviewSubmission.betaReviewState]": "reviewStateFilter", include: "includedRelationships",
  "fields[apps]": "appFields", "fields[builds]": "buildFields", "fields[preReleaseVersions]": "versionFields",
  "fields[buildBetaDetails]": "betaFields", "fields[betaAppReviewSubmissions]": "reviewFields",
  "fields[betaAppReviewDetails]": "reviewMetadataFields", "fields[betaAppLocalizations]": "testInfoFields",
  "fields[betaBuildLocalizations]": "notesFields", "fields[betaGroups]": "groupFields",
  "limit[betaGroups]": "includedGroupLimit", "limit[betaBuildLocalizations]": "includedNotesLimit", limit: "pageLimit", cursor: "pageCursor",
})

export class PreflightError extends Error {
  constructor(code, stage = null, httpStatus = null, errors = []) {
    super(code)
    this.code = code
    this.stage = STAGES.includes(stage) ? stage : null
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null
    const rows = Array.isArray(errors) ? errors.slice(0, 5) : []
    this.errorCodes = rows.map(row => row?.code).filter(value => typeof value === "string" && /^[A-Z][A-Z0-9_.]{0,79}$/.test(value))
    this.errorParameters = [...new Set(rows.map(row => {
      const key = row?.source?.parameter
      return typeof key === "string" && Object.hasOwn(PARAMETERS, key) ? PARAMETERS[key] : null
    }).filter(Boolean))]
  }
}

export function queryFor(stage, appId = null, cursor = null) {
  if (!STAGES.includes(stage)) throw new PreflightError("UNSAFE_STAGE")
  if (stage !== "appMetadata" && (typeof appId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(appId))) throw new PreflightError("INVALID_APP_ID", stage)
  const query = stage === "appMetadata" ? {
    "filter[bundleId]": TARGET.bundleId, include: "betaAppReviewDetail,betaAppLocalizations",
    "fields[apps]": "bundleId,primaryLocale,betaAppReviewDetail,betaAppLocalizations",
    "fields[betaAppReviewDetails]": "contactFirstName,contactLastName,contactEmail,contactPhone,demoAccountRequired,demoAccountName,demoAccountPassword",
    "fields[betaAppLocalizations]": "locale,description,feedbackEmail", limit: "2",
  } : stage === "targetBuild" ? {
    "filter[app]": appId, "filter[version]": TARGET.build,
    "filter[preReleaseVersion.version]": TARGET.version, "filter[preReleaseVersion.platform]": "IOS",
    include: "preReleaseVersion,buildBetaDetail,betaAppReviewSubmission,betaBuildLocalizations,betaGroups",
    "fields[builds]": "version,processingState,expired,buildAudienceType,usesNonExemptEncryption,preReleaseVersion,buildBetaDetail,betaAppReviewSubmission,betaBuildLocalizations,betaGroups",
    "fields[preReleaseVersions]": "version,platform", "fields[buildBetaDetails]": "internalBuildState,externalBuildState,autoNotifyEnabled",
    "fields[betaAppReviewSubmissions]": "betaReviewState", "fields[betaBuildLocalizations]": "locale,whatsNew",
    "fields[betaGroups]": GROUP_FIELDS, "limit[betaGroups]": "50", "limit[betaBuildLocalizations]": "50", limit: "2",
  } : stage === "existingPublicGroup" ? {
    "filter[app]": appId, "fields[betaGroups]": GROUP_FIELDS, limit: "200",
  } : {
    "filter[app]": appId, "filter[preReleaseVersion.version]": TARGET.version, "filter[preReleaseVersion.platform]": "IOS",
    "filter[betaAppReviewSubmission.betaReviewState]": "WAITING_FOR_REVIEW,IN_REVIEW",
    include: "preReleaseVersion,betaAppReviewSubmission", "fields[builds]": "version,preReleaseVersion,betaAppReviewSubmission",
    "fields[preReleaseVersions]": "version,platform", "fields[betaAppReviewSubmissions]": "betaReviewState", limit: "200",
  }
  if (cursor !== null) {
    if (!["existingPublicGroup", "activeVersionReviews"].includes(stage) || typeof cursor !== "string" || !cursor.length || cursor.length > 2048) throw new PreflightError("UNSAFE_CURSOR", stage)
    query.cursor = cursor
  }
  const path = stage === "appMetadata" ? "/v1/apps" : stage === "existingPublicGroup" ? "/v1/betaGroups" : "/v1/builds"
  const url = new URL(path, ORIGIN)
  url.search = new URLSearchParams(query).toString()
  return url
}

export function nextCursor(value, stage, appId) {
  const next = new URL(value, ORIGIN)
  const base = queryFor(stage, appId)
  const keys = [...next.searchParams.keys()]
  if (next.origin !== ORIGIN || next.username || next.password || next.hash || next.pathname !== base.pathname
    || keys.length !== new Set(keys).size || keys.some(key => key !== "cursor" && !base.searchParams.has(key))
    || [...base.searchParams].some(([key, val]) => next.searchParams.get(key) !== val)) throw new PreflightError("UNSAFE_PAGINATION", stage)
  const cursor = next.searchParams.get("cursor")
  queryFor(stage, appId, cursor)
  if (!cursor) throw new PreflightError("UNSAFE_PAGINATION", stage)
  return cursor
}

export function createPreflightClient(credentials, fetchImpl = fetch) {
  return async (stage, appId = null, cursor = null) => {
    const url = queryFor(stage, appId, cursor)
    if (![credentials.issuer, credentials.keyId, credentials.privateKey].every(value => typeof value === "string" && value.length)) throw new PreflightError("MISSING_CREDENTIALS", stage)
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url")
    const now = Math.floor(Date.now() / 1000)
    const header = encode({ alg: "ES256", kid: credentials.keyId, typ: "JWT" })
    const payload = encode({ iss: credentials.issuer, iat: now, exp: now + 120, aud: "appstoreconnect-v1", scope: [`GET ${url.pathname}${url.search}`] })
    let token
    try {
      token = `${header}.${payload}.${sign("sha256", Buffer.from(`${header}.${payload}`), { key: credentials.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`
    } catch { throw new PreflightError("SIGNING_FAILED", stage) }
    let response
    try {
      response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) })
    } catch { throw new PreflightError("TRANSPORT_FAILED", stage) }
    if (!response.ok) {
      let errors = []
      try { errors = (await response.json())?.errors } catch {}
      throw new PreflightError("HTTP_FAILED", stage, response.status, errors)
    }
    try { return await response.json() } catch { throw new PreflightError("INVALID_JSON", stage) }
  }
}

const state = value => typeof value === "string" && /^[A-Z_]{1,80}$/.test(value) ? value : "UNKNOWN"
const present = value => typeof value === "string" && value.trim().length > 0
const relation = (response, row, name, type) => response.included?.find(item => item.type === type && item.id === row.relationships?.[name]?.data?.id)
const relatedRows = (response, row, name, type) => {
  const ids = row.relationships?.[name]?.data
  if (!Array.isArray(ids)) return []
  return (response.included ?? []).filter(item => item.type === type && ids.some(id => id.id === item.id && id.type === type))
}

function one(response, type, stage) {
  if (!Array.isArray(response.data) || response.data.length !== 1 || response.data[0].type !== type || typeof response.data[0].id !== "string" || !response.data[0].id.length || response.data[0].id.length > 100) throw new PreflightError("TARGET_NOT_UNIQUE", stage)
  return response.data[0]
}

function assertVersion(response, build, stage) {
  const version = relation(response, build, "preReleaseVersion", "preReleaseVersions")
  if (version?.attributes?.version !== TARGET.version || version?.attributes?.platform !== "IOS") throw new PreflightError("WRONG_PRERELEASE_VERSION", stage)
}

function baseReceipt() {
  return { status: "unavailable", target: { bundleId: TARGET.bundleId, version: TARGET.version, build: TARGET.build },
    metadata: null, build: null, publicGroup: null, activeVersionReviews: null, submissionPrerequisitesComplete: null,
    physicalDeviceAcceptance: "unverified" }
}

export async function inspectPreflight(get) {
  const result = baseReceipt()
  let stage = "appMetadata"
  try {
    const apps = await get(stage)
    const app = one(apps, "apps", stage)
    if (app.attributes?.bundleId !== TARGET.bundleId || !/^[A-Za-z0-9_-]{1,100}$/.test(app.id)) throw new PreflightError("WRONG_APP", stage)
    const locale = app.attributes?.primaryLocale
    const primaryLocale = typeof locale === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(locale) ? locale : null
    const details = relation(apps, app, "betaAppReviewDetail", "betaAppReviewDetails")?.attributes
    const appLocalizations = relatedRows(apps, app, "betaAppLocalizations", "betaAppLocalizations")
    const appLocalizationRelation = app.relationships?.betaAppLocalizations
    const localizationIds = Array.isArray(appLocalizationRelation?.data) ? appLocalizationRelation.data.filter(row => row.type === "betaAppLocalizations" && typeof row.id === "string").map(row => row.id) : null
    const localizationsComplete = localizationIds !== null && localizationIds.length === appLocalizationRelation.data.length && new Set(localizationIds).size === localizationIds.length
      && appLocalizations.length === localizationIds.length && !appLocalizationRelation.links?.next && localizationIds.length < 50
      && !(appLocalizationRelation.meta?.paging?.total > localizationIds.length)
    const testInfo = appLocalizations.find(row => row.attributes?.locale === primaryLocale)?.attributes
    result.metadata = { primaryLocale, reviewContactComplete: ["contactFirstName", "contactLastName", "contactEmail", "contactPhone"].every(key => present(details?.[key])),
      reviewLoginComplete: details?.demoAccountRequired === false || (details?.demoAccountRequired === true && present(details.demoAccountName) && present(details.demoAccountPassword)),
      primaryLocaleTestInfoComplete: primaryLocale !== null && present(testInfo?.description) && present(testInfo?.feedbackEmail),
      appLocalizationsInspectionComplete: localizationsComplete,
      allLocaleDescriptionsPresent: localizationsComplete && appLocalizations.length > 0 && appLocalizations.every(row => present(row.attributes?.description)) }

    stage = "targetBuild"
    const builds = await get(stage, app.id)
    const build = one(builds, "builds", stage)
    if (build.attributes?.version !== TARGET.build) throw new PreflightError("WRONG_BUILD", stage)
    assertVersion(builds, build, stage)
    const beta = relation(builds, build, "buildBetaDetail", "buildBetaDetails")?.attributes
    const review = relation(builds, build, "betaAppReviewSubmission", "betaAppReviewSubmissions")?.attributes
    const notes = relatedRows(builds, build, "betaBuildLocalizations", "betaBuildLocalizations")
    const groupRelation = build.relationships?.betaGroups
    const associatedIds = Array.isArray(groupRelation?.data) ? groupRelation.data.filter(row => row.type === "betaGroups" && typeof row.id === "string").map(row => row.id) : null
    const associationsComplete = associatedIds !== null && associatedIds.length === groupRelation.data.length && !groupRelation.links?.next && associatedIds.length < 50
      && !(groupRelation.meta?.paging?.total > associatedIds.length)
    const noteRelation = build.relationships?.betaBuildLocalizations
    const noteIds = Array.isArray(noteRelation?.data) ? noteRelation.data.filter(row => row?.type === "betaBuildLocalizations" && typeof row.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(row.id)).map(row => row.id) : null
    const notesComplete = noteIds !== null && noteIds.length === noteRelation.data.length && new Set(noteIds).size === noteIds.length
      && noteIds.length < 50 && !noteRelation.links?.next && notes.length === noteIds.length
      && noteIds.every(id => notes.filter(row => row.id === id).length === 1)
      && notes.every(row => typeof row.attributes?.locale === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(row.attributes.locale))
      && !(noteRelation.meta?.paging?.total > notes.length)
    const primaryNotes = notes.filter(row => primaryLocale !== null && row.attributes?.locale === primaryLocale)
    const primaryNoteCount = notesComplete && primaryLocale !== null ? primaryNotes.length : null
    const uniquePrimaryNote = primaryNoteCount === 1 ? primaryNotes[0].attributes : null
    const primaryNoteBlank = uniquePrimaryNote && (uniquePrimaryNote.whatsNew === null || typeof uniquePrimaryNote.whatsNew === "string")
      ? !present(uniquePrimaryNote.whatsNew) : null
    result.build = { processingState: state(build.attributes.processingState), expired: typeof build.attributes.expired === "boolean" ? build.attributes.expired : null,
      audience: state(build.attributes.buildAudienceType), encryptionDeclarationPresent: typeof build.attributes.usesNonExemptEncryption === "boolean",
      internalBuildState: state(beta?.internalBuildState), externalBuildState: state(beta?.externalBuildState),
      autoNotifyEnabled: typeof beta?.autoNotifyEnabled === "boolean" ? beta.autoNotifyEnabled : null,
      existingBetaReviewState: state(review?.betaReviewState), primaryLocaleNotesPresent: primaryLocale !== null && notes.some(row => row.attributes?.locale === primaryLocale && present(row.attributes?.whatsNew)) ? true : notesComplete ? false : null,
      notesInspectionComplete: notesComplete,
      primaryLocaleNoteRecordCount: primaryNoteCount,
      primaryLocaleNoteRecordExists: primaryNoteCount === null ? null : primaryNoteCount > 0,
      primaryLocaleNoteRecordUnique: primaryNoteCount === null ? null : primaryNoteCount === 1,
      primaryLocaleNoteRecordBlank: primaryNoteBlank,
      groupAssociationComplete: associationsComplete, associatedGroupCount: associationsComplete ? new Set(associatedIds).size : null }

    stage = "existingPublicGroup"
    const groups = new Map()
    let cursor = null
    for (let page = 0; page < 5; page++) {
      const response = await get(stage, app.id, cursor)
      if (!Array.isArray(response.data)) throw new PreflightError("INVALID_GROUPS", stage)
      for (const group of response.data) {
        if (group.type !== "betaGroups" || typeof group.id !== "string" || !group.id.length || group.id.length > 100 || typeof group.attributes?.isInternalGroup !== "boolean"
          || !Object.hasOwn(group.attributes, "publicLinkId") || !Object.hasOwn(group.attributes, "publicLinkEnabled")
          || (group.attributes.publicLinkId !== null && typeof group.attributes.publicLinkId !== "string")
          || (group.attributes.publicLinkEnabled !== null && typeof group.attributes.publicLinkEnabled !== "boolean")) throw new PreflightError("INVALID_GROUPS", stage)
        groups.set(group.id, group.attributes)
      }
      if (!response.links?.next) {
        if (response.meta?.paging?.total > groups.size || (!response.meta?.paging && response.data.length >= 200)) throw new PreflightError("INCOMPLETE_COLLECTION", stage)
        cursor = null; break
      }
      cursor = nextCursor(response.links.next, stage, app.id)
    }
    if (cursor) throw new PreflightError("PAGINATION_LIMIT", stage)
    const matches = [...groups].filter(([, group]) => group.publicLinkId === TARGET.invite && group.isInternalGroup === false)
    const selected = matches.length === 1 ? matches[0] : null
    result.publicGroup = { matchingExternalGroupCount: matches.length, enabled: selected ? (typeof selected[1].publicLinkEnabled === "boolean" ? selected[1].publicLinkEnabled : null) : null,
      targetAssociated: selected ? (associatedIds?.includes(selected[0]) ? true : associationsComplete ? false : null) : null }

    stage = "activeVersionReviews"
    const reviews = new Map()
    cursor = null
    for (let page = 0; page < 5; page++) {
      const response = await get(stage, app.id, cursor)
      if (!Array.isArray(response.data)) throw new PreflightError("INVALID_REVIEWS", stage)
      for (const row of response.data) {
        if (row.type !== "builds" || typeof row.id !== "string" || !row.id.length || row.id.length > 100) throw new PreflightError("INVALID_REVIEWS", stage)
        assertVersion(response, row, stage)
        const reviewState = relation(response, row, "betaAppReviewSubmission", "betaAppReviewSubmissions")?.attributes?.betaReviewState
        if (!["WAITING_FOR_REVIEW", "IN_REVIEW"].includes(reviewState)) throw new PreflightError("INVALID_REVIEW_STATE", stage)
        reviews.set(row.id, row.id === build.id)
      }
      if (!response.links?.next) {
        if (response.meta?.paging?.total > reviews.size || (!response.meta?.paging && response.data.length >= 200)) throw new PreflightError("INCOMPLETE_COLLECTION", stage)
        cursor = null; break
      }
      cursor = nextCursor(response.links.next, stage, app.id)
    }
    if (cursor) throw new PreflightError("PAGINATION_LIMIT", stage)
    result.activeVersionReviews = { count: reviews.size, targetBuildIncluded: [...reviews.values()].some(Boolean) }
    result.submissionPrerequisitesComplete = result.metadata.reviewContactComplete && result.metadata.reviewLoginComplete && result.metadata.primaryLocaleTestInfoComplete
      && result.metadata.appLocalizationsInspectionComplete && result.metadata.allLocaleDescriptionsPresent
      && result.build.processingState === "VALID" && result.build.expired === false && result.build.audience === "APP_STORE_ELIGIBLE" && result.build.encryptionDeclarationPresent
      && result.build.primaryLocaleNotesPresent && result.publicGroup.matchingExternalGroupCount === 1 && result.publicGroup.enabled === true && result.publicGroup.targetAssociated === true
      && result.activeVersionReviews.count === 0 && result.build.externalBuildState === "READY_FOR_BETA_SUBMISSION"
    result.status = "observed"
  } catch (error) {
    const safe = error instanceof PreflightError ? error : new PreflightError("UNEXPECTED_ERROR", stage)
    result.error = { code: safe.code, stage: safe.stage, httpStatus: safe.httpStatus, errorCodes: safe.errorCodes, errorParameters: safe.errorParameters }
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = await inspectPreflight(createPreflightClient({ issuer: process.env.APPLE_API_ISSUER, keyId: process.env.APPLE_API_KEY, privateKey: process.env.APPLE_API_PRIVATE_KEY }))
  const output = process.argv[2] ?? ".ci/testflight45-preflight.json"
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(receipt, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(receipt))
  if (receipt.status !== "observed") process.exitCode = 1
}
