export function observeVisibilitySentinel(root: Element, sentinel: Element, onVisible: () => void): () => void {
  let active = true
  const observer = new IntersectionObserver((entries) => {
    if (active && entries.some((entry) => entry.isIntersecting)) onVisible()
  }, { root, rootMargin: "100px" })
  observer.observe(sentinel)
  return () => { active = false; observer.disconnect() }
}
