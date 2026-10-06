export const actionVariants = {
  "friend.command": { "send": "friend.request.send", "accept": "friend.request.accept", "reject": "friend.request.reject", "remove": "friend.remove", "cancel": "friend.request.cancel", "owner-decision": "friend.owner_decision.command", "block": "user.block", "unblock": "user.unblock" },
  "friend.owner_decision.command": { "approve": "friend.request.approve", "deny": "friend.request.deny" },
  "member.management.command": { "kick": "server.member.kick", "leave": "channel.member.leave", "remove": "channel.member.remove" },
  "billing.redirect": {
    "checkout": "billing.checkout.start",
    "portal": "billing.portal.open"
  },
  "machine.command": {
    "delete": "machine.delete",
    "update": "machine.update"
  },
  "device.authorization.command": {
    "approve": "device.authorization.approve",
    "deny": "device.authorization.deny"
  },
  "account.deletion.command": {
    "code": "account.deletion.code.request",
    "delete": "account.delete"
  },
  "server.member.command": {
    "role": "server.member.role.change",
    "kick": "server.member.kick"
  },
  "bot.command": {
    "create-command": "bot.create",
    "active-command": "bot.active.change",
    "update-command": "bot.update",
    "delete-command": "bot.delete",
    "reset-command": "bot.session.reset",
    "machine-reset-command": "machine.agents.reset",
    "avatar-command": "bot.avatar.upload"
  },
  "channel.member.command": {
    "add": "channel.member.add",
    "remove": "channel.member.remove"
  },
} as const

export function resolveActionName(base: string, variables: unknown): string {
  const value = variables && typeof variables === "object" ? variables as Record<string, unknown> : {}
  const action = value.action && typeof value.action === "object" ? value.action as Record<string, unknown> : {}
  const input = value.input && typeof value.input === "object" ? value.input as Record<string, unknown> : {}
  const kind = value.kind ?? action.kind ?? input.kind ?? value.action ?? value.decision
  const variants: Record<string, Readonly<Record<string, string>>> = actionVariants
  return variants[base] ? typeof kind === "string" ? variants[base]?.[kind] ?? "command.unknown" : "command.unknown" : base
}
