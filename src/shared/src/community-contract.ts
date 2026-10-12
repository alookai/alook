export const COMMUNITY_CONTRACT_HEADER = "X-Alook-Community-Contract"
export const COMMUNITY_CONTRACT_VERSION = 2 as const
export const COMMUNITY_RESOURCE_CONTRACT_VERSION = 3 as const

export type CommunityContract = 1 | 2 | 3

export function requestedCommunityContract(headers: Pick<Headers, "get">): CommunityContract | null {
  const value = headers.get(COMMUNITY_CONTRACT_HEADER)
  if (value === null || value === "1") return 1
  if (value === "2") return 2
  if (value === "3") return 3
  return null
}

export function requestsCommunityContract(headers: Pick<Headers, "get">): boolean {
  const contract = requestedCommunityContract(headers)
  return contract === 2 || contract === 3
}
