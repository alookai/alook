export const COMMUNITY_CONTRACT_HEADER = "X-Alook-Community-Contract"
export const COMMUNITY_CONTRACT_VERSION = 2 as const

export type CommunityContract = 1 | typeof COMMUNITY_CONTRACT_VERSION

export function requestsCommunityContract(headers: Pick<Headers, "get">): boolean {
  return headers.get(COMMUNITY_CONTRACT_HEADER) === String(COMMUNITY_CONTRACT_VERSION)
}
