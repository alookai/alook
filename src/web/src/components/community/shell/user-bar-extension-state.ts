export type UserBarExtensionKind = "none" | "inbox" | "update" | "profile"

export type UserBarUpdatePhase =
  | "expanded"
  | "collapsedBadge"
  | "updating"
  | "retry"

export type UserBarUpdateState = {
  phase: UserBarUpdatePhase
  targetMachineIds: readonly string[]
  acceptedMachineIds: readonly string[]
  failedMachineIds: readonly string[]
  pendingMachineIds: readonly string[]
}

export type UserBarExtensionState = {
  active: UserBarExtensionKind
  update: UserBarUpdateState | null
}

export type UserBarExtensionAction =
  | {
      type: "update.sync"
      collapsed: boolean
      eligibleMachineIds: readonly string[]
    }
  | { type: "update.eligibility"; eligibleMachineIds: readonly string[] }
  | { type: "update.clear" }
  | { type: "update.open" }
  | { type: "update.collapse" }
  | { type: "update.dispatch"; machineIds: readonly string[] }
  | {
      type: "update.settle"
      acceptedMachineIds: readonly string[]
      failedMachineIds: readonly string[]
    }
  | { type: "extension.open"; extension: "inbox" | "profile" }
  | { type: "extension.close"; extension?: UserBarExtensionKind }

export const initialUserBarExtensionState: UserBarExtensionState = {
  active: "none",
  update: null,
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function without(values: readonly string[], removed: ReadonlySet<string>): string[] {
  return values.filter((value) => !removed.has(value))
}

function intersect(values: readonly string[], allowed: ReadonlySet<string>): string[] {
  return values.filter((value) => allowed.has(value))
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function withEligibleMachines(
  state: UserBarExtensionState,
  eligibleMachineIds: readonly string[],
): UserBarExtensionState {
  if (!state.update) return state
  const eligible = new Set(eligibleMachineIds)
  const targetMachineIds = unique(eligibleMachineIds)
  if (targetMachineIds.length === 0) {
    return {
      active: state.active === "update" ? "none" : state.active,
      update: null,
    }
  }
  const acceptedMachineIds = intersect(state.update.acceptedMachineIds, eligible)
  const failedMachineIds = intersect(state.update.failedMachineIds, eligible)
  const pendingMachineIds = intersect(state.update.pendingMachineIds, eligible)
  const phase: UserBarUpdatePhase = failedMachineIds.length > 0
    ? "retry"
    : acceptedMachineIds.length > 0 || pendingMachineIds.length > 0
      ? "updating"
      : state.active === "update"
        ? "expanded"
        : "collapsedBadge"
  if (
    phase === state.update.phase
    && sameValues(targetMachineIds, state.update.targetMachineIds)
    && sameValues(acceptedMachineIds, state.update.acceptedMachineIds)
    && sameValues(failedMachineIds, state.update.failedMachineIds)
    && sameValues(pendingMachineIds, state.update.pendingMachineIds)
  ) return state
  return {
    ...state,
    update: {
      phase,
      targetMachineIds,
      acceptedMachineIds,
      failedMachineIds,
      pendingMachineIds,
    },
  }
}

export function userBarExtensionReducer(
  state: UserBarExtensionState,
  action: UserBarExtensionAction,
): UserBarExtensionState {
  switch (action.type) {
    case "update.sync": {
      if (state.update) return withEligibleMachines(state, action.eligibleMachineIds)
      if (action.eligibleMachineIds.length === 0) return state
      const preserveActiveExtension = action.collapsed || state.active !== "none"
      return {
        active: preserveActiveExtension ? state.active : "update",
        update: {
          phase: preserveActiveExtension ? "collapsedBadge" : "expanded",
          targetMachineIds: unique(action.eligibleMachineIds),
          acceptedMachineIds: [],
          failedMachineIds: [],
          pendingMachineIds: [],
        },
      }
    }
    case "update.eligibility":
      return withEligibleMachines(state, action.eligibleMachineIds)
    case "update.clear":
      return {
        active: state.active === "update" ? "none" : state.active,
        update: null,
      }
    case "update.open":
      if (!state.update) return state
      return {
        active: "update",
        update: {
          ...state.update,
          phase: state.update.phase === "collapsedBadge"
            ? "expanded"
            : state.update.phase,
        },
      }
    case "update.collapse":
      if (!state.update) {
        return state.active === "update" ? { ...state, active: "none" } : state
      }
      return {
        active: state.active === "update" ? "none" : state.active,
        update: {
          ...state.update,
          phase: state.update.phase === "expanded"
            ? "collapsedBadge"
            : state.update.phase,
        },
      }
    case "update.dispatch": {
      if (!state.update) return state
      const requested = new Set(action.machineIds)
      return {
        active: "update",
        update: {
          ...state.update,
          phase: "updating",
          failedMachineIds: without(state.update.failedMachineIds, requested),
          pendingMachineIds: unique([
            ...state.update.pendingMachineIds,
            ...action.machineIds,
          ]),
        },
      }
    }
    case "update.settle": {
      if (!state.update) return state
      const target = new Set(state.update.targetMachineIds)
      const acceptedActionMachineIds = action.acceptedMachineIds.filter((machineId) => (
        target.has(machineId)
      ))
      const failedActionMachineIds = action.failedMachineIds.filter((machineId) => (
        target.has(machineId)
      ))
      const accepted = new Set(acceptedActionMachineIds)
      const failed = new Set(failedActionMachineIds)
      const settled = new Set([...accepted, ...failed])
      const acceptedMachineIds = unique([
        ...without(state.update.acceptedMachineIds, failed),
        ...acceptedActionMachineIds,
      ])
      const failedMachineIds = unique([
        ...without(state.update.failedMachineIds, accepted),
        ...failedActionMachineIds,
      ])
      return {
        active: state.active,
        update: {
          ...state.update,
          phase: failedMachineIds.length > 0 ? "retry" : "updating",
          acceptedMachineIds,
          failedMachineIds,
          pendingMachineIds: without(state.update.pendingMachineIds, settled),
        },
      }
    }
    case "extension.open":
      return {
        active: action.extension,
        update: state.update?.phase === "expanded"
          ? { ...state.update, phase: "collapsedBadge" }
          : state.update,
      }
    case "extension.close":
      if (action.extension && state.active !== action.extension) return state
      return {
        active: "none",
        update: state.update?.phase === "expanded"
          ? { ...state.update, phase: "collapsedBadge" }
          : state.update,
      }
  }
}

export function userBarUpdateBadgePhase(
  state: UserBarExtensionState,
): Exclude<UserBarUpdatePhase, "expanded"> | null {
  if (!state.update || state.active === "update") return null
  return state.update.phase === "expanded" ? "collapsedBadge" : state.update.phase
}
