import {
  CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
  CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY,
} from "./cloud-code-monster-pet-constants";
import type { CloudCodeMonsterPetPreset } from "./cloud-code-monster-pet-types";

export const CLOUD_CODE_MONSTER_PET_PRESETS: CloudCodeMonsterPetPreset[] = [
  {
    id: "pet-1",
    name: "Claude Pixel",
    group: "A-Look Originals",
    feature: "square",
    bodyTop: "#f08a62",
    body: "#f08a62",
    bodyDark: "#d86444",
    bodyLight: "#f6a47e",
    bodySideLight: "#f08a62",
    bodySideDark: "#d86444",
    accent: "#d86444",
    accessory: "#f1bc62",
    eye: "#1a1410",
    highlight: "#f6e7d7",
  },
  {
    id: "pet-2",
    name: "Spark Bolt Pal",
    group: "A-Look Originals",
    feature: "bolt",
    bodyTop: "#f6cf2e",
    body: "#f6cf2e",
    bodyDark: "#d9a922",
    bodyLight: "#ffe37a",
    bodySideLight: "#f6cf2e",
    bodySideDark: "#d9a922",
    accent: "#f08c3a",
    accessory: "#fff3b8",
    eye: "#241c12",
    highlight: "#fff7c7",
    cheek: "#f08c3a",
  },
  {
    id: "pet-3",
    name: "Star Puff",
    group: "A-Look Originals",
    feature: "star",
    bodyTop: "#f88ba3",
    body: "#f88ba3",
    bodyDark: "#d9647f",
    bodyLight: "#fbb0c0",
    bodySideLight: "#f88ba3",
    bodySideDark: "#d9647f",
    accent: "#a85ec0",
    accessory: "#ffd75e",
    eye: "#27224d",
    highlight: "#fff0f6",
    cheek: "#ef5d7d",
  },
  {
    id: "pet-4",
    name: "Blink Hiss",
    group: "A-Look Originals",
    feature: "leaf",
    bodyTop: "#5cb14c",
    body: "#5cb14c",
    bodyDark: "#449a3c",
    bodyLight: "#6fc05c",
    bodySideLight: "#5cb14c",
    bodySideDark: "#449a3c",
    accent: "#33773a",
    accessory: "#6fc05c",
    eye: "#161812",
    eyeOffsetMax: { x: 2, y: 1 },
    highlight: "#d8f0c8",
  },
  {
    id: "pet-5",
    name: "Peek Ghost",
    group: "A-Look Originals",
    feature: "ghost",
    bodyTop: "#e4e9f6",
    body: "#e4e9f6",
    bodyDark: "#a4b0d2",
    bodyLight: "#f3f5fc",
    bodySideLight: "#d0d8ec",
    bodySideDark: "#a4b0d2",
    accent: "#ec6189",
    accessory: "#f0a7bd",
    eye: "#1c1a26",
    highlight: "#ffffff",
  },
  {
    id: "pet-6",
    name: "Dust Puff",
    group: "A-Look Originals",
    feature: "soot",
    bodyTop: "#26262b",
    body: "#26262b",
    bodyDark: "#15151a",
    bodyLight: "#4a4b52",
    bodySideLight: "#26262b",
    bodySideDark: "#15151a",
    accent: "#6c6f7a",
    accessory: "#f5efda",
    eye: "#f5efda",
    highlight: "#ffffff",
  },
];

export function getCloudCodeMonsterPreset(presetId?: string | null) {
  return (
    CLOUD_CODE_MONSTER_PET_PRESETS.find((preset) => preset.id === presetId) ??
    CLOUD_CODE_MONSTER_PET_PRESETS[0]!
  );
}

export function readCloudCodeMonsterPetPresetId() {
  if (typeof localStorage === "undefined") {
    return CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id;
  }

  try {
    return getCloudCodeMonsterPreset(
      localStorage.getItem(CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY)
    ).id;
  } catch {
    return CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id;
  }
}

export function writeCloudCodeMonsterPetPresetId(presetId: string) {
  const nextPreset = getCloudCodeMonsterPreset(presetId);

  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY, nextPreset.id);
    } catch {}
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT, {
        detail: { presetId: nextPreset.id },
      })
    );
  }

  return nextPreset.id;
}
