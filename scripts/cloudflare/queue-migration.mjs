#!/usr/bin/env node

import { pathToFileURL } from "node:url"

export const QUEUE_MIGRATION_RESOURCES = Object.freeze({
  oldWorker: "alook-wake-worker",
  oldQueue: "alook-wake",
  oldDlq: "alook-wake-dlq",
  newWorker: "alook-queue-worker",
  newQueue: "alook-queue",
  newDlq: "alook-queue-dlq",
})

export function buildQueueMigrationPlan() {
  const names = QUEUE_MIGRATION_RESOURCES
  return {
    mode: "plan-only",
    executesCommands: false,
    dualWrite: false,
    phases: [
      {
        id: "prepare",
        mutating: true,
        commands: [
          `pnpm exec wrangler queues create ${names.newQueue}`,
          `pnpm exec wrangler queues create ${names.newDlq}`,
        ],
        gate: "Confirm the new Queue and DLQ exist with zero producers.",
      },
      {
        id: "deploy-compatible-consumer",
        mutating: true,
        commands: ["pnpm --filter @alook/queue-worker deploy"],
        gate: "Verify the new consumer accepts legacy wake and v1 queue tasks.",
      },
      {
        id: "producer-cutover",
        mutating: true,
        commands: ["pnpm --filter @alook/web deploy"],
        gate: `Verify Web has exactly one producer binding, targeting ${names.newQueue}; never dual-write.`,
      },
      {
        id: "drain-and-observe",
        mutating: false,
        commands: [
          `pnpm exec wrangler queues info ${names.oldQueue}`,
          `pnpm exec wrangler queues info ${names.newQueue}`,
          `pnpm exec wrangler queues info ${names.newDlq}`,
        ],
        gate: "Old depth and oldest age are zero, no old producer remains, and new wake traffic is healthy.",
      },
      {
        id: "cleanup",
        mutating: true,
        separatelyAuthorized: true,
        commands: [
          `pnpm exec wrangler queues delete ${names.oldQueue}`,
          `pnpm exec wrangler queues delete ${names.oldDlq}`,
          `pnpm exec wrangler delete --name ${names.oldWorker}`,
        ],
        gate: "STOP unless exact production cleanup authorization is recorded after the drain gate passes.",
      },
    ],
  }
}

function renderText(plan) {
  const lines = [
    "Queue migration plan (display only; no commands were executed)",
    "No dual-write: cut over the single Web producer only after the compatible consumer is ready.",
  ]
  for (const phase of plan.phases) {
    lines.push("", `${phase.id}${phase.separatelyAuthorized ? " [SEPARATE AUTHORIZATION REQUIRED]" : ""}`)
    lines.push(...phase.commands.map((command) => `  ${command}`), `  Gate: ${phase.gate}`)
  }
  return lines.join("\n")
}

function main(argv) {
  if (argv.includes("--execute")) {
    console.error("Refusing --execute: this script is intentionally plan/read-only.")
    process.exitCode = 2
    return
  }
  const plan = buildQueueMigrationPlan()
  console.log(argv.includes("--json") ? JSON.stringify(plan, null, 2) : renderText(plan))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
