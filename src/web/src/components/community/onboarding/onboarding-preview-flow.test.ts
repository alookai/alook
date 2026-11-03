import migratedSource0 from "./community-onboarding-form.tsx?raw"
import migratedSource1 from "./initialize-community-onboarding.ts?raw"
import migratedSource2 from "./onboarding-machine-dialog.tsx?raw"
import migratedSource3 from "./onboarding-model-dialog.tsx?raw"
import migratedSource4 from "./onboarding-select-dialog.preview.tsx?raw"
import migratedSource5 from "./onboarding-select-dialog.tsx?raw"
import migratedSource6 from "./onboarding-status-dialog.tsx?raw"
const migratedSources: Record<string, string> = {
  "community-onboarding-form.tsx": migratedSource0,
  "initialize-community-onboarding.ts": migratedSource1,
  "onboarding-machine-dialog.tsx": migratedSource2,
  "onboarding-model-dialog.tsx": migratedSource3,
  "onboarding-select-dialog.preview.tsx": migratedSource4,
  "onboarding-select-dialog.tsx": migratedSource5,
  "onboarding-status-dialog.tsx": migratedSource6,
}
import resolvedRawInput0 from "./onboarding-select-dialog.preview.tsx?raw"
import resolvedRawInput1 from "./community-onboarding-form.tsx?raw"
import resolvedRawInput2 from "./onboarding-machine-dialog.tsx?raw"
import resolvedRawInput3 from "../machines/me-machines-route.tsx?raw"
import staticContractInput0 from "./onboarding-status-dialog.tsx?raw"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const directory = dirname(fileURLToPath(import.meta.url))
const previewSource = resolvedRawInput0
const onboardingFormSource = resolvedRawInput1
const machineDialogSource = resolvedRawInput2
const machinesPageSource = resolvedRawInput3

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

  it("inherits the shared Dialog backdrop across every onboarding dialog", () => {
    for (const filename of [
      "onboarding-select-dialog.tsx",
      "onboarding-machine-dialog.tsx",
      "onboarding-status-dialog.tsx",
      "onboarding-model-dialog.tsx",
    ]) {
      const source = migratedSources[filename]
      expect(source).toContain("<DialogContent")
      expect(source).not.toContain("overlayClassName=")
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

  it("uses bot terminology and renders the dynamic checkpoint team", () => {
    for (const filename of [
      "community-onboarding-form.tsx",
      "initialize-community-onboarding.ts",
      "onboarding-select-dialog.preview.tsx",
      "onboarding-status-dialog.tsx",
    ]) {
      const source = migratedSources[filename]

      expect(source).not.toMatch(/\b(?:Guide|Builder)\b/)
    }

    expect(previewSource).toMatch(/\bbots?\b/)
    expect(previewSource).toContain('key: "reviewer"')
    expect(staticContractInput0)
      .toContain("checkpoint.bots.map")
    expect(onboardingFormSource).not.toContain("Two bots")
  })

  it("keeps onboarding mounted until shell navigation commits the new room", () => {
    expect(onboardingFormSource).toMatch(
      /onContinue=\{async \(\) => \{[\s\S]*?pendingDestination: destination[\s\S]*?navigate\(initializationResult\.serverId, initializationResult\.publicChannelId\)/,
    )
    expect(onboardingFormSource).toMatch(
      /const pendingDestination = protocol\?\.pendingDestination[\s\S]*?pathname !== pendingDestination[\s\S]*?completeCommunityOnboarding\(communityRuntime, pathname\)/,
    )
  })
})
