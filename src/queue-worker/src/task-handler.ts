import {
  createLogger,
  dispatchOneUnreadWake,
  type AlookQueueTask,
  type Database,
} from "@alook/shared"
import { processMobilePush } from "./mobile-push"

const log = createLogger({ service: "queue-worker-task-handler" })

type TaskHandlerDependencies = {
  dispatchWake: typeof dispatchOneUnreadWake
  processMobilePush: typeof processMobilePush
}

const defaultDependencies: TaskHandlerDependencies = {
  dispatchWake: dispatchOneUnreadWake,
  processMobilePush,
}

export async function executeQueueTask(
  db: Database,
  env: Env,
  task: AlookQueueTask,
  dependencies: TaskHandlerDependencies = defaultDependencies,
): Promise<void> {
  if (task.kind === "bot-wake") {
    const payload = { messageId: task.messageId, botUserId: task.botUserId }
    const result = await dependencies.dispatchWake(db, env, payload)
    if (result.outcome === "skip") {
      log.info("bot_wake_skipped", {
        kind: task.kind,
        botUserId: task.botUserId,
        messageId: task.messageId,
        reason: result.reason,
      })
    } else if (result.outcome === "attempted_nowhere") {
      log.info("bot_wake_attempted_nowhere", {
        kind: task.kind,
        botUserId: task.botUserId,
        machineId: result.machineId,
      })
    }
    return
  }

  try {
    const result = await dependencies.processMobilePush(db, env, task)
    log.info("mobile_push_task_complete", {
      kind: task.kind,
      messageId: task.messageId,
      userId: task.userId,
      ...result,
    })
  } catch (error) {
    log.warn("mobile_push_task_failed", {
      kind: task.kind,
      messageId: task.messageId,
      userId: task.userId,
      errorName: error instanceof Error ? error.name : "unknown",
    })
  }
}
