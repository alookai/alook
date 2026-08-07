export function resolveChannelDisplayName(args: {
  localName?: string | null
  forumPostTitle?: string | null
  topLevelName?: string | null
  childChannelName?: string | null
  forumListName?: string | null
  threadListName?: string | null
  fallback?: string
}): string {
  return args.localName
    ?? args.forumPostTitle
    ?? args.topLevelName
    ?? args.forumListName
    ?? args.threadListName
    ?? args.childChannelName
    ?? args.fallback
    ?? "channel"
}
