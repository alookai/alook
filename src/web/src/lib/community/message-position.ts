export type MessagePositionState = "pending" | "ready" | "empty" | "error"

export type MessageNeighborhood = { page: object; older: boolean; newer: boolean }

export type MessageRequestResult =
  | { status: "success"; window: object; windowState?: (window: object | undefined) => "pending" | "ready" | "retired" }
  | { status: "error" | "retired" | "missing" }

export type NewPositionResult = "success" | "error" | "retired" | "missing" | "cancelled"

export type NewPositionRequest =
  | { accepted: false }
  | { accepted: true; completed: Promise<NewPositionResult> }

export type MessageRequest =
  | { accepted: false }
  | { accepted: true; completed: Promise<MessageRequestResult>; cancel?: () => void }
