export type MessagePositionState = "pending" | "ready" | "empty" | "error"

export type MessageRequestResult =
  | { status: "success"; window: object }
  | { status: "error" | "retired" }

export type MessageRequest =
  | { accepted: false }
  | { accepted: true; completed: Promise<MessageRequestResult> }
