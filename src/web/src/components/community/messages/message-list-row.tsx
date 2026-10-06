import { DateDivider, NewDivider } from "../dividers"
import { tid } from "@/lib/community/testids"
import { ChannelIcon } from "../channels/channel-icon"
import { MessageRow } from "./message-row"
import type { FlatItem } from "@/lib/community/message-list-items"
import type { MessageListController } from "./message-list-controller"
import type { ResolvedMessageListProps } from "./message-list-types"

export function renderMessageListHero(props: ResolvedMessageListProps) {
  return props.hero ?? (
    <>
      <div className="mb-2 grid size-12 place-items-center rounded-full bg-muted/60">
        <ChannelIcon className="text-xl text-muted-foreground" />
      </div>
      <h2 className="text-xl font-semibold leading-tight">{props.channel}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Beginning of the channel. Say hello, share what you&apos;re working on, or drop a link.
      </p>
    </>
  )
}

export function renderMessageListRow(
  item: FlatItem,
  props: ResolvedMessageListProps,
  controller: MessageListController,
  index: number,
) {
  return (
    <div className="flow-root" data-message-row-key={item.key}>
      {index === 0 && (
        <div className="mb-6 pt-8">
          {props.hasMore ? (
            <div ref={controller.topSentinelRef} className="flex h-8 items-center justify-center text-xs text-muted-foreground">
              {props.isFetchingOlder ? "Loading older messages…" : ""}
            </div>
          ) : renderMessageListHero(props)}
        </div>
      )}
      {item.newDivider
        ? <NewDivider dateLabel={item.dateLabel} />
        : item.dateLabel && <DateDivider label={item.dateLabel} />}
        <div data-msg-id={item.m.id} data-testid={tid.message(item.m.id)}>
          <MessageRow
            m={item.m}
            hoverCapable={props.hoverCapable}
            viewerUserId={props.viewerUserId}
            pinned={props.pinnedIds?.has(item.m.id)}
            highlighted={controller.jumped === item.m.id}
            onOpenThread={props.onOpenThread}
            onOpenProfile={props.onOpenProfile}
            onToggleReactionId={props.onToggleReaction}
            onReactId={props.onReact}
            onReplyId={props.onReply}
            mentionText={item.m.authorId
              ? props.resolveAuthorMentionText?.(item.m.authorId) ?? undefined
              : undefined}
            onInsertMentionText={props.onInsertMentionText}
            onPinId={props.onPin}
            onMarkId={props.onMark}
            onCreateThreadId={props.onCreateThread}
            onCopyId={props.onCopy}
            onEditId={item.m.authorId === props.viewerUserId ? props.onEdit : undefined}
            onRetryId={props.onRetry}
            onDismissId={props.onDismiss}
            onJumpToId={controller.jumpTo}
            onPreviewImage={props.onPreviewImage}
            onPreviewAttachment={props.onPreviewAttachment}
            resolveUserName={props.resolveUserName}
            selectMode={controller.selectMode}
            selected={controller.selectedIds.has(item.m.id)}
            onToggleSelectId={controller.onToggleSelectId}
            onEnterSelectId={controller.onEnterSelectId}
          />
        </div>
      {index === controller.items.length - 1 && props.hasMoreNewer && (
        <div ref={controller.bottomSentinelRef} className="mt-6 flex h-8 items-center justify-center text-xs text-muted-foreground">
          {props.isFetchingNewer ? "Loading newer messages…" : ""}
        </div>
      )}
    </div>
  )
}
