export type ComposerAccessoryRailOccupancy =
  | {
    mode: "normal"
    left: boolean
    center: boolean
  }
  | {
    mode: "selection"
  }

export type ComposerAccessoryRailLayout =
  | "empty"
  | "centered"
  | "left-only"

export function allocateComposerAccessoryRail(
  occupancy: ComposerAccessoryRailOccupancy,
): ComposerAccessoryRailLayout {
  if (occupancy.mode === "selection") return "centered"
  if (occupancy.center) return "centered"
  if (occupancy.left) return "left-only"
  return "empty"
}
