export type ComposerAccessoryRailOccupancy =
  | {
    mode: "normal"
    left: boolean
    center: boolean
    right: boolean
  }
  | {
    mode: "selection"
    left: boolean
    right: boolean
  }

export type ComposerAccessoryRailLayout =
  | "empty"
  | "centered"
  | "left-right"
  | "left-only"
  | "right-only"

export function allocateComposerAccessoryRail(
  occupancy: ComposerAccessoryRailOccupancy,
): ComposerAccessoryRailLayout {
  if (occupancy.mode === "selection" || occupancy.center) return "centered"
  if (occupancy.left && occupancy.right) return "left-right"
  if (occupancy.left) return "left-only"
  if (occupancy.right) return "right-only"
  return "empty"
}
