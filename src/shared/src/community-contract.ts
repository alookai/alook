export const COMMUNITY_CONTRACT_HEADER = "X-Alook-Community-Contract"
export const COMMUNITY_CONTRACT_VERSION = 2 as const

export function requestsCommunityContractV2(headers: Pick<Headers, "get">): boolean {
  return headers.get(COMMUNITY_CONTRACT_HEADER) === String(COMMUNITY_CONTRACT_VERSION)
}
