import { BUSINESS_SCHEMA_VERSION } from "./business-schema-version"

export const COMMUNITY_CONTRACT_HEADER = "X-Alook-Community-Contract"
export const COMMUNITY_CONTRACT_VERSION = BUSINESS_SCHEMA_VERSION
export const COMMUNITY_RESOURCE_CONTRACT_VERSION = BUSINESS_SCHEMA_VERSION
export type CommunityContract = typeof BUSINESS_SCHEMA_VERSION

export function requestedCommunityContract(headers: Pick<Headers, "get">): CommunityContract | null {
  return headers.get(COMMUNITY_CONTRACT_HEADER) === String(BUSINESS_SCHEMA_VERSION) ? BUSINESS_SCHEMA_VERSION : null
}

export function requestsCommunityContract(headers: Pick<Headers, "get">): boolean {
  return requestedCommunityContract(headers) === BUSINESS_SCHEMA_VERSION
}
