import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const directory = dirname(fileURLToPath(import.meta.url))
const previewSource = readFileSync(
  resolve(directory, "onboarding-select-dialog.preview.tsx"),
  "utf8",
)
const onboardingFormSource = readFileSync(
  resolve(directory, "community-onboarding-form.tsx"),
  "utf8",
)
const machineDialogSource = readFileSync(
  resolve(directory, "onboarding-machine-dialog.tsx"),
  "utf8",
)
const machinesPageSource = readFileSync(
  resolve(directory, "../../../app/c/me/machines/page.tsx"),
  "utf8",
)

describe("onboarding preview flow", () => {
  it("shows the machine step between harness and identity", () => {
    expect(previewSource).toContain("<OnboardingMachineDialog")
    expect(previewSource).toContain('setMode("machine")')
    expect(previewSource).toMatch(
      /<OnboardingMachineDialog[\s\S]*?onConnected=\{\(\) => \{[\s\S]*?setMode\("identity"\)/,
    )
  })

  it("continues from identity into the setting-up preview", () => {
    expect(previewSource).toContain('<OnboardingStatusDialog')
    expect(previewSource).toContain('setMode("status")')
  })

  it("keeps a blurred backdrop across every onboarding dialog", () => {
    for (const filename of [
      "onboarding-select-dialog.tsx",
      "onboarding-machine-dialog.tsx",
      "onboarding-status-dialog.tsx",
    ]) {
      expect(readFileSync(resolve(directory, filename), "utf8")).toContain(
        'overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm"',
      )
    }
  })

  it("reuses the existing machine pairing form instead of duplicating its UI", () => {
    expect(machineDialogSource).toContain("<PairMachineSteps")
    expect(machineDialogSource).toContain(
      'from "@/components/community/machines/pair-machine-sheet"',
    )
    expect(machineDialogSource).not.toContain("Terminal command")
  })

  it("offers a development-only online seam without changing production gating", () => {
    expect(machinesPageSource).toContain('process.env.NODE_ENV !== "production"')
    expect(machinesPageSource).toContain('onboardingPreview === "online"')
    expect(previewSource).toContain("simulateOnlineMachine")
    expect(previewSource).toContain("showSettingUp")
    expect(previewSource).toContain('id: "preview-machine"')
    expect(previewSource).toContain("previewCommand:")
  })

  it("exposes the canonical harness and identity testids in preview mode", () => {
    expect(previewSource).toContain("tid.onboardingHarnessDialog")
    expect(previewSource).toContain("tid.onboardingHarnessOption")
    expect(previewSource).toContain("tid.onboardingIdentityDialog")
    expect(previewSource).toContain("tid.onboardingIdentityOption")
  })

  it("uses bot terminology without fixed onboarding bot names", () => {
    for (const filename of [
      "community-onboarding-form.tsx",
      "initialize-community-onboarding.ts",
      "onboarding-select-dialog.preview.tsx",
      "onboarding-status-dialog.tsx",
    ]) {
      const source = readFileSync(resolve(directory, filename), "utf8")

      expect(source).not.toMatch(/\b(?:Guide|Builder|agents?)\b/)
    }

    expect(previewSource).toMatch(/\bbots?\b/)
  })

  it("keeps onboarding mounted until shell navigation commits the new room", () => {
    expect(onboardingFormSource).toMatch(
      /onContinue=\{\(\) => \{[\s\S]*?pendingCompletionDestinationRef\.current = destination[\s\S]*?navigate\(initializationResult\.serverId, initializationResult\.publicChannelId\)/,
    )
    expect(onboardingFormSource).toMatch(
      /const pendingDestination = pendingCompletionDestinationRef\.current[\s\S]*?pathname !== pendingDestination[\s\S]*?pendingCompletionDestinationRef\.current = null[\s\S]*?completeCommunityOnboarding\(\)/,
    )
  })
})
