import { MessageRoute } from "@/components/community/messages/message-route"

export default async function MessagePage({ params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params
  return <MessageRoute messageId={messageId} />
}
