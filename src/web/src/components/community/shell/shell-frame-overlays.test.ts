import { createElement } from "react"
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import TestRenderer, { act } from "react-test-renderer"
import { ShellFrameOverlays } from "./shell-frame-overlays"

vi.mock("@/components/ui/dialog", () => ({
  Dialog: (props: Record<string, unknown>) => createElement("dialog-root", props),
  DialogContent: (props: Record<string, unknown>) => createElement("dialog-content", props),
}))
vi.mock("../settings/user-settings", () => ({
  UserSettings: (props: Record<string, unknown>) => createElement("user-settings", props),
}))
vi.mock("../social/profile-card", () => ({
  ProfileCard: (props: Record<string, unknown>) => createElement("profile-card", props),
}))
vi.mock("../messages/image-lightbox", () => ({
  ImageLightbox: (props: Record<string, unknown>) => createElement("image-lightbox", props),
}))
vi.mock("../messages/attachment-preview-sheet", () => ({
  AttachmentPreviewSheet: (props: Record<string, unknown>) => createElement("attachment-sheet", props),
}))
vi.mock("../image-crop-dialog", () => ({
  ImageCropDialog: (props: Record<string, unknown>) => createElement("crop-dialog", props),
}))

const controller = {
  currentUser: { id: "self" },
  profile: {
    data: { userId: "remote", name: "Remote" },
    x: 12,
    y: 34,
    initialStatusEmoji: "🌱",
    initialStatusText: "Growing",
  },
  closeProfile: vi.fn(),
  profileMessage: vi.fn(),
  updateOwnStatus: vi.fn(),
  preview: { url: "/image.png", alt: "image" },
  closePreview: vi.fn(),
  attachmentPreview: { id: "a1", filename: "notes.txt" },
  onAttachmentPreviewOpenChange: vi.fn(),
  editingProfile: true,
  onUserSettingsOpenChange: vi.fn(),
  userSettingsProps: { onClose: vi.fn(), userId: "self", userName: "Self" },
  pendingAvatarCrop: {
    imageSrc: "blob:avatar",
    originalFileName: "avatar.png",
    onCropped: vi.fn(),
    onCancel: vi.fn(),
  },
} as never

describe("ShellFrameOverlays", () => {
  beforeEach(() => {
    for (const value of Object.values(controller as unknown as Record<string, unknown>)) {
      if (typeof value === "function" && "mockClear" in value) {
        (value as ReturnType<typeof vi.fn>).mockClear()
      }
    }
  })

  it("renders each overlay once in the preserved order", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrameOverlays, {
        controller,
        breakpoint: "desktop",
        profileStatusSeeds: {
          initialStatusEmoji: "🌱",
          initialStatusText: "Growing",
        },
        extraDialogs: createElement("extra-dialog"),
      }))
    })

    const types = renderer.root.findAll(
      (node) => typeof node.type === "string",
    ).map((node) => node.type)
    expect(types.filter((type) => type === "profile-card")).toHaveLength(1)
    expect(types.filter((type) => type === "image-lightbox")).toHaveLength(1)
    expect(types.filter((type) => type === "attachment-sheet")).toHaveLength(1)
    expect(types.filter((type) => type === "user-settings")).toHaveLength(1)
    expect(types.filter((type) => type === "crop-dialog")).toHaveLength(1)
    expect(types.filter((type) => type === "extra-dialog")).toHaveLength(1)
    expect(types.indexOf("profile-card")).toBeLessThan(types.indexOf("image-lightbox"))
    expect(types.indexOf("image-lightbox")).toBeLessThan(types.indexOf("attachment-sheet"))
    expect(types.indexOf("attachment-sheet")).toBeLessThan(types.indexOf("dialog-root"))
    expect(types.indexOf("dialog-root")).toBeLessThan(types.indexOf("crop-dialog"))
    expect(types.indexOf("crop-dialog")).toBeLessThan(types.indexOf("extra-dialog"))

    const profileCard = renderer.root.findByType("profile-card")
    expect(profileCard.props.initialStatusEmoji).toBe("🌱")
    expect(profileCard.props.initialStatusText).toBe("Growing")
    expect(renderer.root.findByType("crop-dialog").props.maskShape).toBe("circle")

    renderer.root.findByType("attachment-sheet").props.onOpenChange(false)
    expect(controller.onAttachmentPreviewOpenChange).toHaveBeenCalledWith(false)
    renderer.root.findByType("dialog-root").props.onOpenChange(false)
    expect(controller.onUserSettingsOpenChange).toHaveBeenCalledWith(false)
    renderer.root.findByType("user-settings").props.onClose()
    expect(controller.userSettingsProps.onClose).toHaveBeenCalledTimes(1)
  })

  it("omits status seed props when the mobile caller omits them", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrameOverlays, {
        controller,
        breakpoint: "mobile",
      }))
    })
    const profileCard = renderer.root.findByType("profile-card")
    expect("initialStatusEmoji" in profileCard.props).toBe(false)
    expect("initialStatusText" in profileCard.props).toBe(false)
  })

  it("omits nullable overlays while keeping closed sheet and settings wiring", async () => {
    const emptyController = {
      ...controller,
      profile: null,
      preview: null,
      attachmentPreview: null,
      editingProfile: false,
      pendingAvatarCrop: null,
    } as never
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrameOverlays, {
        controller: emptyController,
        breakpoint: "desktop",
      }))
    })

    expect(renderer.root.findAllByType("profile-card")).toHaveLength(0)
    expect(renderer.root.findAllByType("image-lightbox")).toHaveLength(0)
    expect(renderer.root.findAllByType("crop-dialog")).toHaveLength(0)
    expect(renderer.root.findByType("attachment-sheet").props).toMatchObject({
      attachment: null,
      open: false,
    })
    expect(renderer.root.findByType("dialog-root").props.open).toBe(false)
  })

  it("stays a render-only boundary", () => {
    const source = readFileSync(new URL("./shell-frame-overlays.tsx", import.meta.url), "utf8")
    expect(source).toContain(
      'key={`${profile.data.userId ?? profile.data.name}:${profile.x}:${profile.y}`}',
    )
    for (const forbidden of [
      "/api/",
      "@/lib/query-keys",
      "@/stores/",
      "@/hooks/community/mutations",
      "@/lib/auth-client",
      "@/lib/query-persister",
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })
})
