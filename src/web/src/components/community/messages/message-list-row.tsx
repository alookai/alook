import { DateDivider, NewDivider } from "../dividers"
import { tid } from "@/lib/community/testids"
import { MessageRow } from "./message-row"
import type { FlatItem } from "@/lib/community/message-list-items"
import type { MessageListController } from "./message-list-controller"
import type { ResolvedMessageListProps } from "./message-list-types"

export function renderMessageListRow(
  item: FlatItem,
  props: ResolvedMessageListProps,
  controller: MessageListController,
) {
  return (
    <>
      {item.kind === "date-divider" && <DateDivider label={item.label} />}
      {item.kind === "new-divider" && <NewDivider dateLabel={item.dateLabel} />}
      {item.kind === "message" && (
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
            onImageLoad={controller.onImageLoad}
            selectMode={controller.selectMode}
            selected={controller.selectedIds.has(item.m.id)}
            onToggleSelectId={controller.onToggleSelectId}
            onEnterSelectId={controller.onEnterSelectId}
          />
        </div>
      )}
    </>
  )
}
