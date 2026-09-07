import { createElement } from "react"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { ShellFrameOverlays } from "./shell-frame-overlays"

const hostProps = new Map<string, Record<string, unknown>>()
function host(name: string) {
  const Host = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
    hostProps.set(name, props)
    return createElement(name, { "data-host": name }, children)
  }
  Host.displayName = `Host(${name})`
  return Host
}

vi.mock("@/components/ui/dialog", () => ({
  Dialog: host("dialog-root"),
  DialogContent: host("dialog-content"),
}))
vi.mock("../settings/user-settings", () => ({
  UserSettings: host("user-settings"),
}))
vi.mock("../social/profile-card", () => ({
  ProfileCard: host("profile-card"),
}))
vi.mock("../messages/image-lightbox", () => ({
  ImageLightbox: host("image-lightbox"),
}))
vi.mock("../messages/attachment-preview-sheet", () => ({
  AttachmentPreviewSheet: host("attachment-sheet"),
}))
vi.mock("../image-crop-dialog", () => ({
  ImageCropDialog: host("crop-dialog"),
}))

const controller = {
  currentUser: { id: "self" },
  profile: {
    data: { userId: "remote", name: "Remote" },
    x: 12,
    y: 34,
  },
  closeProfile: vi.fn(),
  profileMessage: vi.fn(),
  updateOwnStatus: vi.fn(),
  openOwnerProfile: vi.fn(),
  openBotAudit: vi.fn(),
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
    hostProps.clear()
    for (const value of Object.values(controller as unknown as Record<string, unknown>)) {
      if (typeof value === "function" && "mockClear" in value) {
        (value as ReturnType<typeof vi.fn>).mockClear()
      }
    }
  })

  it("renders each overlay once in the preserved order", () => {
    const renderer = render(createElement(ShellFrameOverlays, {
      controller,
      breakpoint: "desktop",
      extraDialogs: createElement("extra-dialog"),
    }))

    const types = Array.from(renderer.container.querySelectorAll("*"))
      .map((node) => node.localName)
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

    const profileCard = hostProps.get("profile-card")!
    expect("initialStatusEmoji" in profileCard).toBe(false)
    expect("initialStatusText" in profileCard).toBe(false)
    expect(profileCard.onOpenOwnerProfile).toBe(controller.openOwnerProfile)
    expect(profileCard.onOpenBotAudit).toBe(controller.openBotAudit)
    expect(hostProps.get("crop-dialog")?.maskShape).toBe("circle")

    ;(hostProps.get("attachment-sheet")?.onOpenChange as (open: boolean) => void)(false)
    expect(controller.onAttachmentPreviewOpenChange).toHaveBeenCalledWith(false)
    ;(hostProps.get("dialog-root")?.onOpenChange as (open: boolean) => void)(false)
    expect(controller.onUserSettingsOpenChange).toHaveBeenCalledWith(false)
    ;(hostProps.get("user-settings")?.onClose as () => void)()
    expect(controller.userSettingsProps.onClose).toHaveBeenCalledTimes(1)
  })

  it("omits status seed props when the mobile caller omits them", () => {
    render(createElement(ShellFrameOverlays, {
      controller,
      breakpoint: "mobile",
    }))
    const profileCard = hostProps.get("profile-card")!
    expect("initialStatusEmoji" in profileCard).toBe(false)
    expect("initialStatusText" in profileCard).toBe(false)
    expect("activityStatusEmoji" in profileCard).toBe(false)
    expect("activityStatusText" in profileCard).toBe(false)
  })

  it("omits nullable overlays while keeping closed sheet and settings wiring", () => {
    const emptyController = {
      ...controller,
      profile: null,
      preview: null,
      attachmentPreview: null,
      editingProfile: false,
      pendingAvatarCrop: null,
    } as never
    const renderer = render(createElement(ShellFrameOverlays, {
      controller: emptyController,
      breakpoint: "desktop",
    }))

    expect(renderer.container.querySelectorAll("profile-card")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("image-lightbox")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("crop-dialog")).toHaveLength(0)
    expect(hostProps.get("attachment-sheet")).toMatchObject({
      attachment: null,
      open: false,
    })
    expect(hostProps.get("dialog-root")?.open).toBe(false)
  })

  it("stays a render-only boundary", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/components/community/shell/shell-frame-overlays.tsx",
    ), "utf8")
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
