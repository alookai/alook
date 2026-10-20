export async function loadSelectedTrace({ document, search, fetch, start, loadText }) {
  const status = document.createElement("p")
  status.className = "local-viewer-status"
  status.setAttribute("role", "status")
  status.textContent = "Reading retained trace…"
  document.body.prepend(status)
  try {
    start()
    const trace = new URLSearchParams(search).get("trace")
    if (!trace || !/^[a-f\d]{32}$/i.test(trace)) throw new Error("Select a retained trace from the local observations list.")
    const response = await fetch("/api/traces/" + trace, { credentials: "omit" })
    if (!response.ok) throw new Error(`Trace is unavailable (${response.status}). It may have expired from local retention.`)
    const detail = await response.json()
    if (!detail.spanCount) throw new Error("No spans fit this view's source limits.")
    loadText(JSON.stringify(detail.otlp), "local trace " + trace)
    if (document.getElementById("app").hidden || !document.getElementById("welcome").hidden) throw new Error("The waterfall could not render this trace. The original received batch remains available in the parent view.")
    status.textContent = `${detail.spanCount} retained spans · ${detail.truncated ? "Partial view: " + detail.reasons.join(", ") : "Trace loaded"}`
    status.dataset.state = "ready"
  } catch (cause) {
    status.textContent = cause.message
    status.dataset.state = "error"
  }
}
