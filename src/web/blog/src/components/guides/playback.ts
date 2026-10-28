type Candidate = { id: string; top: number; height: number };
export function closestVisibleGuide(candidates: Candidate[], viewportHeight: number) {
  return candidates.filter(({ top, height }) => height > 0 && Math.max(0, Math.min(viewportHeight, top + height) - Math.max(0, top)) / height >= 0.35)
    .sort((a, b) => Math.abs(a.top + a.height / 2 - viewportHeight / 2) - Math.abs(b.top + b.height / 2 - viewportHeight / 2))[0]?.id;
}
type Entry = { element: HTMLElement; select: () => void; pause: () => void };
const entries = new Map<string, Entry>();
let pending: number | null = null;
export function refreshGuidePlayback() {
  if (document.hidden) {
    for (const entry of entries.values()) entry.pause();
    return;
  }
  if (pending !== null) return;
  pending = window.requestAnimationFrame(() => {
    pending = null;
    const selected = document.hidden ? undefined : closestVisibleGuide([...entries].map(([id, { element }]) => {
      const { top, height } = element.getBoundingClientRect();
      return { id, top, height };
    }), window.innerHeight);
    for (const [id, entry] of entries) {
      if (id !== selected) entry.pause();
    }
    if (selected) entries.get(selected)?.select();
  });
}
export function claimGuidePlayback(id: string) {
  for (const [otherId, entry] of entries) if (id !== otherId) entry.pause();
}
export function registerGuidePlayback(id: string, entry: Entry) {
  if (entries.size === 0) {
    window.addEventListener("scroll", refreshGuidePlayback, { passive: true });
    window.addEventListener("resize", refreshGuidePlayback);
    document.addEventListener("visibilitychange", refreshGuidePlayback);
  }
  entries.set(id, entry);
  return () => {
    entries.delete(id);
    if (entries.size === 0) {
      window.removeEventListener("scroll", refreshGuidePlayback);
      window.removeEventListener("resize", refreshGuidePlayback);
      document.removeEventListener("visibilitychange", refreshGuidePlayback);
      if (pending !== null) window.cancelAnimationFrame(pending);
      pending = null;
    } else refreshGuidePlayback();
  };
}
