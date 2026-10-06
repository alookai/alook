import React from "react"
import { beforeEach, describe, expect, it } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { useHomePetSettings, writeHomePetSettings } from "./home-pet-settings"
import { readCloudCodeMonsterPetPresetId, useCloudCodeMonsterPetPresetId, writeCloudCodeMonsterPetPresetId } from "@/components/home-pet/cloud-code-monster-pet-presets"
import { CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY } from "@/components/home-pet/cloud-code-monster-pet-constants"
function Probe({ name }: { name: string }) {
  const { enabled } = useHomePetSettings()
  const preset = useCloudCodeMonsterPetPresetId()
  return <output data-testid={name}>{String(enabled)}:{preset}</output>
}
beforeEach(() => { localStorage.clear(); writeHomePetSettings({ enabled: false }); readCloudCodeMonsterPetPresetId() })
describe("native device pet preferences", () => {
  it("device preference writes publish directly to every consumer", () => {
    const mounted = render(<><Probe name="one" /><Probe name="two" /></>)
    act(() => writeHomePetSettings({ enabled: true }))
    expect(mounted.getByTestId("one").textContent).toBe("true:pet-01")
    expect(mounted.getByTestId("two").textContent).toBe("true:pet-01")
    act(() => writeCloudCodeMonsterPetPresetId("pet-02"))
    expect(mounted.getByTestId("one").textContent).toBe("true:pet-02")
  })
  it("cross-tab storage and clear update both native selectors", () => {
    const mounted = render(<><Probe name="one" /><Probe name="two" /></>)
    act(() => {
      localStorage.setItem("alook-home-pet-enabled-v1", "true")
      window.dispatchEvent(new StorageEvent("storage", { key: "alook-home-pet-enabled-v1" }))
      localStorage.setItem(CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY, "pet-02")
      window.dispatchEvent(new StorageEvent("storage", { key: CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY }))
    })
    expect(mounted.getByTestId("one").textContent).toBe("true:pet-02")
    expect(mounted.getByTestId("two").textContent).toBe("true:pet-02")
    act(() => { localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null })) })
    expect(mounted.getByTestId("one").textContent).toBe("false:pet-01")
  })
})
