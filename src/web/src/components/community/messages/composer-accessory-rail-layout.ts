export type ComposerAccessoryRailOccupancy = {
  mode: "normal"
  left: boolean
  center: boolean
  right?: boolean
}

export type ComposerAccessoryRailLayout =
  | "empty"
  | "centered"
  | "left-only"
  | "edges"

export function allocateComposerAccessoryRail(
  occupancy: ComposerAccessoryRailOccupancy,
): ComposerAccessoryRailLayout {
  if (occupancy.center) return "centered"
  if (occupancy.right) return "edges"
  if (occupancy.left) return "left-only"
  return "empty"
}
