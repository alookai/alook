import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { describe, expect, it, vi } from "vitest"
import { EmojiPickerPopover } from "./emoji-picker"
import { CommunityPreviewNavigation } from "../shell/community-preview-navigation"

const mocks = vi.hoisted(() => ({ picker: vi.fn(), loadData: vi.fn() }))
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }))
vi.mock("@emoji-mart/react", () => ({ default: (props: { onEmojiSelect: (value: { native: string }) => void }) => {
  mocks.picker(props)
  return <button onClick={() => props.onEmojiSelect({ native: "🎉" })}>Choose emoji</button>
} }))
vi.mock("@emoji-mart/data", () => {
  mocks.loadData()
  return { default: { emojis: { tada: { skins: [{ native: "🎉" }] } } } }
})

describe("demo emoji affordance", () => {
  it("retains the original trigger without mounting a picker in preview", () => {
    const pick = vi.fn()
    render(<CommunityPreviewNavigation value={true}><EmojiPickerPopover onPick={pick}><button className="hover:bg-accent">Emoji preview</button></EmojiPickerPopover></CommunityPreviewNavigation>)
    const trigger = screen.getByRole("button", { name: "Emoji preview" })
    expect(trigger).toHaveClass("hover:bg-accent")
    act(() => trigger.click())
    expect(trigger).not.toHaveAttribute("aria-expanded")
    expect(pick).not.toHaveBeenCalled()
  })
})

describe("native emoji picker", () => {
  it("keeps full native data, theme and selection behavior", async () => {
    const pick = vi.fn()
    const open = vi.fn()
    render(<EmojiPickerPopover onPick={pick} onOpenChange={open}><button>Emoji</button></EmojiPickerPopover>)
    expect(screen.getByRole("button", { name: "Emoji" })).toBeVisible()
    act(() => screen.getByRole("button", { name: "Emoji" }).click())
    expect(open).toHaveBeenLastCalledWith(true)
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose emoji" })).toBeVisible())
    const props = mocks.picker.mock.lastCall![0]
    expect(props).toMatchObject({ theme: "dark", set: "native", previewPosition: "none", skinTonePosition: "none" })
    expect(props.data).toEqual({ emojis: { tada: { skins: [{ native: "🎉" }] } } })
    act(() => screen.getByRole("button", { name: "Choose emoji" }).click())
    expect(pick).toHaveBeenCalledWith("🎉")
    expect(open).toHaveBeenLastCalledWith(false)
  })
})
