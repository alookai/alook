import React from "react"
import { describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"

vi.mock("@/hooks/community/use-bot-memberships", () => ({
  useBotMemberships: () => ({
    pending: false,
    data: { servers: [{
      id: "owned", name: "Owned server", handle: "Owned#1234", icon: null, canLeave: false,
      channels: [
        { id: "/Owned#1234/public", name: "public", type: "text", canLeave: false },
        { id: "/Owned#1234/private", name: "private", type: "text", canLeave: true },
      ],
    }] },
  }),
}))
vi.mock("../shell/community-sheet", () => ({
  CommunitySheet: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}))
vi.mock("../server-icon", () => ({ ServerIcon: () => <span /> }))
vi.mock("../entity-icon", () => ({ EntityIcon: () => <span /> }))

import { BotMembershipsSheet } from "./bot-memberships-sheet"

describe("bot membership owner restrictions", () => {
  it("disables server and public exit while preserving private channel exit", () => {
    const result = render(<BotMembershipsSheet bot={{ id: "bot", name: "Bot" }} open onOpenChange={() => {}} />)
    for (const id of ["owned", "/Owned#1234/public"]) {
      const button = result.getByTestId(tid.botMembershipsLeave(id)) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe("The server owner cannot leave")
      expect(button.getAttribute("aria-label")).toMatch(/^Leave /)
      expect(button.textContent).toBe("")
    }
    const privateExit = result.getByTestId(tid.botMembershipsLeave("/Owned#1234/private")) as HTMLButtonElement
    expect(privateExit.disabled).toBe(false)
    expect(result.getByTestId(tid.botMembershipsChannel("/Owned#1234/private")).querySelector('[aria-label="Private channel"]')).not.toBeNull()
    expect(result.getByTestId(tid.botMembershipsChannel("/Owned#1234/public")).querySelector('[aria-label="Private channel"]')).toBeNull()
  })
})
