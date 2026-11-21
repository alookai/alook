export type MessageWireType = {
  type: "chat" | "system" | "question"
  systemKind?: "thread"
}

export function projectMessageWireType(
  type: string | null | undefined,
): MessageWireType {
  if (type === "thread_created") {
    return { type: "system", systemKind: "thread" }
  }
  if (type === "system") return { type: "system" }
  if (type === "question") return { type: "question" }
  return { type: "chat" }
}
