import type { Msg } from "@/lib/community/models/message"

export function trialMessage(index: number, authorId = index % 3 === 0 ? "demo-gus" : "demo-alli"): Msg {
  const id = `renderer-trial-${index}`
  const message: Msg = { id, type: "chat", seq: index + 1, authorId, authorName: authorId === "demo-gus" ? "Gus" : "Alli", createdAt: new Date(Date.UTC(2026, 10, 18, 8, index)).toISOString(), content: `Message ${index}: the same message and actions in every renderer.` }
  switch (index % 10) {
    case 1: return { ...message, content: `A **shared** message with a [link](https://alook.ai), inline \`code\` and a list.\n\n- Read together\n- Keep the same actions\n\n\`\`\`typescript\n${Array.from({ length: 18 }, (_, i) => `const item${i} = ${i}`).join("\n")}\n\`\`\`` }
    case 2: return { ...message, replyTo: { id: `renderer-trial-${index - 1}`, authorId: "demo-alli", authorName: "Alli", text: "Keep the original reply action." } }
    case 3: return { ...message, attachments: [{ kind: "image", name: "Profile artwork", url: "/landing/people/lin.webp", width: 320, height: 400 }] }
    case 4: return { ...message, content: `The existing sandboxed HTML preview.\n\n[alook-html-preview](trial-html-${index})`, attachments: [{ id: `trial-html-${index}`, kind: "file", name: "attachment.html", url: "/preview/attachment.html", size: "1 KB", contentType: "text/html" }] }
    case 5: return { ...message, attachments: [{ id: `trial-pdf-${index}`, kind: "file", name: "example.pdf", url: "/preview/example.pdf", size: "1 KB", contentType: "application/pdf" }] }
    case 6: return { ...message, reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["demo-gus"] }] }
    case 7: return { ...message, thread: { id: `trial-thread-${index}`, name: "Fixture thread", messageCount: 2, lastReplyAt: message.createdAt } }
    case 8: return { ...message, authorId: "demo-gus", clientNonce: `trial-nonce-${index}`, failed: true }
    case 9: return { ...message, type: "system", content: "A shared system row keeps its native presentation." }
    default: return message
  }
}
export function trialPage(start: number, count = 20) { return Array.from({ length: count }, (_, index) => trialMessage(start + index)) }
export const TRIAL_EVENT_SEQUENCE = ["reset", "select", "read-history", "older-twice", "peer-message", "local-fixture-message", "expand-content", "return-current"] as const
