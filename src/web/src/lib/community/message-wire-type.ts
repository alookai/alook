export type MessageWireType = {
  type: "chat" | "system"
  systemKind?: "thread"
}

/** Normalize the stored message discriminator at every human-client wire boundary. */
export function projectMessageWireType(
  type: string | null | undefined,
): MessageWireType {
  if (type === "thread_created") {
    return { type: "system", systemKind: "thread" }
  }
  if (type === "system") return { type: "system" }
  return { type: "chat" }
}
