export const actionVariants = {
  "friend.command": { "send": "friend.request.send", "accept": "friend.request.accept", "reject": "friend.request.reject", "remove": "friend.remove", "cancel": "friend.request.cancel", "owner-decision": "friend.owner_decision.command", "block": "user.block", "unblock": "user.unblock" },
  "friend.owner_decision.command": { "approve": "friend.request.approve", "deny": "friend.request.deny" },
  "member.management.command": { "kick": "server.member.kick", "leave": "channel.member.leave", "remove": "channel.member.remove" },
  "billing.redirect": {
    "checkout": "billing.checkout.start",
    "portal": "billing.portal.open"
  },
  "calendar.command": {
    "create": "calendar.event.create",
    "update": "calendar.event.update",
    "delete": "calendar.event.delete"
  },
  "machine.command": {
    "delete": "machine.delete",
    "update": "machine.update"
  },
  "workspace.settings.command": {
    "update": "workspace.settings.update",
    "delete": "workspace.delete"
  },
  "workspace.members.command": {
    "create-invite": "workspace.invite.create",
    "revoke-invite": "workspace.invite.revoke",
    "remove-member": "workspace.member.remove"
  },
  "device.authorization.command": {
    "approve": "device.authorization.approve",
    "deny": "device.authorization.deny"
  },
  "chat.control.command": {
    "thread": "chat.thread.create",
    "stop": "chat.task.stop"
  },
  "account.deletion.command": {
    "code": "account.deletion.code.request",
    "delete": "account.delete"
  },
  "email.account.command": {
    "create": "email.account.connect",
    "delete": "email.account.delete",
    "sync": "email.account.sync"
  },
  "agent.rail.command": {
    "pin": "agent.pin",
    "unpin": "agent.unpin",
    "reorder-pins": "agent.pins.reorder",
    "reorder-unpinned": "agent.list.reorder"
  },
  "workspace.channel.command": {
    "create": "workspace.channel.create",
    "rename": "workspace.channel.rename",
    "delete": "workspace.channel.delete",
    "reorder": "workspace.channel.reorder"
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
  "chat.session.command": {
    "nap": "chat.session.nap",
    "retry": "chat.task.retry"
  },
  "agent.permission.command": {
    "whitelist-add": "agent.whitelist.add",
    "whitelist-remove": "agent.whitelist.remove",
    "visibility": "agent.visibility.change",
    "grant": "agent.access.grant",
    "revoke": "agent.access.revoke"
  },
  "issue.command": {
    "comment": "issue.comment.create",
    "create": "issue.create",
    "update": "issue.update",
    "delete": "issue.delete"
  },
  "runtime.command": {
    "update": "runtime.update",
    "rescan": "runtime.rescan"
  },
  "agent.link.command": { "create": "agent.link.create", "update": "agent.link.update", "delete": "agent.link.delete" },
  "email.command": { "send": "email.send", "read": "email.read", "delete": "email.delete", "trust": "email.sender.trust" },
  "chat.command": { "persist": "chat.message.persist", "read": "chat.inbox.read" },
  "meeting.command": { "stop": "meeting.stop", "approve": "meeting.approve",
    "create": "meeting.create",
    "update": "meeting.update",
    "delete": "meeting.delete"
  }
} as const

export function resolveActionName(base: string, variables: unknown): string {
  const value = variables && typeof variables === "object" ? variables as Record<string, unknown> : {}
  const action = value.action && typeof value.action === "object" ? value.action as Record<string, unknown> : {}
  const input = value.input && typeof value.input === "object" ? value.input as Record<string, unknown> : {}
  const kind = value.kind ?? action.kind ?? input.kind ?? value.action ?? value.decision
  const variants: Record<string, Readonly<Record<string, string>>> = actionVariants
  return variants[base] ? typeof kind === "string" ? variants[base]?.[kind] ?? "command.unknown" : "command.unknown" : base
}
