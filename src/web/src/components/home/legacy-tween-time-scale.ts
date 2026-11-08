export function legacyTweenTimeScale(): number {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 20 : 1;
}
