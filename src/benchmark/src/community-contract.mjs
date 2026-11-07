export const COMMUNITY_CONTRACT_VERSION = 10

export function assertCommunityContractVersion(version) {
  if (version !== COMMUNITY_CONTRACT_VERSION) throw new Error('communityContractVersion must explicitly be 10')
}

export function readChannelEnvelope(value, channelId, version) {
  assertCommunityContractVersion(version)
  if (!value || value.contractVersion !== version || value.channelId !== channelId
    || !value.channel || value.channel.id !== channelId || typeof value.channel.serverId !== 'string'
    || typeof value.channel.type !== 'string' || !value.access || value.access.channelId !== channelId
    || typeof value.access.canRead !== 'boolean' || typeof value.access.canSend !== 'boolean'
    || typeof value.access.canCreateDiscussion !== 'boolean' || !value.access.canRead || !value.access.canSend) {
    throw new Error('Invalid current Community channel envelope')
  }
  return value.channel
}

export function readAccessMembers(value, channelId, version) {
  assertCommunityContractVersion(version)
  if (!value || value.contractVersion !== version || value.channelId !== channelId || value.relation !== 'access'
    || !Array.isArray(value.members) || value.members.some(member => typeof member?.userId !== 'string' || !member.userId)) {
    throw new Error('Invalid current Community access members')
  }
  return value.members
}

export function fixtureErrorCode(value) {
  return value?.contractVersion === COMMUNITY_CONTRACT_VERSION && typeof value.error?.code === 'string'
    && /^[a-zA-Z0-9_-]{1,80}$/.test(value.error.code) ? value.error.code : 'request-failed'
}
