export type PageTransitionRecord = {
  animations: Array<{ name: string; pseudo: string | null; transforms: Array<string | undefined> }>
  ready: boolean
  readyError: string | null
  finished: boolean
  finishedError: string | null
  targetHref: string | null
}

function horizontalEndpoint(transform: string | undefined): "100%" | "0" | undefined {
  const match = transform?.match(/^translateX\(\s*(100%|0(?:px)?)\s*\)$|^translate\(\s*(100%|0(?:px)?)\s*(?:,\s*0(?:px)?\s*)?\)$/)
  const value = match?.[1] ?? match?.[2]
  return value === "100%" ? value : value === "0" || value === "0px" ? "0" : undefined
}

export function hasCompletedCommunityPageTransition(records: PageTransitionRecord[], name: "community-page-enter" | "community-page-exit",
  action: { afterIndex: number; targetHref: string }) {
  const entering = name === "community-page-enter"
  return records.slice(action.afterIndex).some((record) => record.targetHref === action.targetHref
    && record.ready && !record.readyError && record.finished && !record.finishedError
    && record.animations.some((animation) => animation.name === name
      && animation.pseudo?.startsWith(entering ? "::view-transition-new(" : "::view-transition-old(")
      && horizontalEndpoint(animation.transforms[0]) === (entering ? "100%" : "0")
      && horizontalEndpoint(animation.transforms.at(-1)) === (entering ? "0" : "100%")))
}
