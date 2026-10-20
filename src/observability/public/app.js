export function formatDuration(nanos) {
  const value = BigInt(nanos)
  if (value < 1_000_000n) return `${Number(value / 1000n) / 1000} ms`
  if (value < 1_000_000_000n) return `${Number(value / 1000n) / 1000} ms`
  return `${Number(value / 1_000_000n) / 1000} s`
}

export function formatTimestamp(nanos) {
  return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString().replace("T", " ").replace("Z", " UTC")
}

export function createApp({ document, fetch }) {
  const byId = id => document.getElementById(id)
  const state = { mode: "traces", trace: null, refresh: null, selection: 0 }
  const node = (tag, text, className) => {
    const value = document.createElement(tag)
    if (text !== undefined) value.textContent = text
    if (className) value.className = className
    return value
  }
  const error = value => { byId("error").textContent = value; byId("error").hidden = !value }
  async function request(url, signal) {
    const response = await fetch(url, { signal, credentials: "omit" })
    if (!response.ok) throw new Error(`Local receiver returned ${response.status}. Refresh to try again.`)
    return response.json()
  }
  function parameters() {
    const form = byId("filters")
    const query = new URLSearchParams()
    for (const name of ["page", "session"]) if (form.elements.namedItem(name).value) query.set(name, form.elements.namedItem(name).value)
    return query
  }
  function batchLink(id) {
    const link = node("a", "Download original received batch")
    link.href = "/api/batches/" + encodeURIComponent(id)
    link.download = ""
    return link
  }
  function logRow(row, target) {
    const button = node("button", undefined, "local-row")
    button.type = "button"
    button.append(node("strong", row.eventName || "Log"), node("span", row.summary, "subtle"))
    const links = []
    if (row.traceId) links.push("native trace " + row.traceId)
    if (row.customTraceId) links.push("explicit event trace " + row.customTraceId)
    button.append(node("small", links.join(" · ") || "No explicit trace reference", "mono subtle"))
    button.addEventListener("click", () => { void selectLog(row.id) })
    target.append(button)
  }
  async function selectLog(id) {
    const generation = ++state.selection
    error("")
    try {
      const value = await request("/api/logs/" + encodeURIComponent(id))
      if (generation !== state.selection) return
      const panel = byId("selection")
      panel.replaceChildren(node("h2", value.index.eventName || "Log record"))
      panel.append(node("p", "Original record, resource and scope. Native and explicit event references are preserved separately.", "subtle"), batchLink(value.index.batchId))
      const original = node("pre", JSON.stringify(value, null, 2), "local-json thin-scrollbar")
      panel.append(original)
    } catch (cause) { if (generation === state.selection) error(cause.message) }
  }
  async function selectTrace(trace) {
    const generation = ++state.selection
    state.trace = trace
    error("")
    const panel = byId("selection")
    panel.replaceChildren(node("h2", "Trace " + trace, "mono"))
    const controls = node("div", undefined, "selection-controls")
    const refreshTrace = node("button", "Refresh selected trace")
    refreshTrace.type = "button"
    const frame = node("iframe")
    frame.title = "Trace waterfall"
    frame.className = "local-waterfall"
    const loadFrame = () => { frame.src = "/viewer?trace=" + encodeURIComponent(trace) + "&refresh=" + Date.now() }
    refreshTrace.addEventListener("click", loadFrame)
    controls.append(refreshTrace)
    panel.append(controls, frame)
    loadFrame()
    const originals = node("div", undefined, "original-batches")
    const related = node("div")
    panel.append(originals, node("h3", "Logs with explicit trace references"), related)
    try {
      const [detail, logList] = await Promise.all([request("/api/traces/" + trace), request("/api/logs?trace=" + trace)])
      if (generation !== state.selection) return
      originals.append(node("p", `${detail.spanCount} retained spans${detail.truncated ? " · Partial view: " + detail.reasons.join(", ") : ""}. Original batches can include other traces.`, "subtle"))
      for (const batch of detail.sourceBatches) originals.append(batchLink(batch.id))
      if (!logList.items.length) related.append(node("p", "No explicit log reference received. Other events remain in All logs & measurements.", "subtle"))
      for (const row of logList.items) logRow(row, related)
      if (logList.truncated) related.prepend(node("p", "Showing the first 100 matching logs.", "subtle"))
    } catch (cause) { if (generation === state.selection) error(cause.message) }
  }
  async function refresh() {
    state.refresh?.abort()
    const controller = new AbortController()
    state.refresh = controller
    error("")
    byId("refresh").disabled = true
    try {
      const query = parameters()
      const [stats, list] = await Promise.all([request("/api/stats", controller.signal), request(`/api/${state.mode}?${query}`, controller.signal)])
      if (controller.signal.aborted) return
      byId("stats").textContent = `${stats.spans} spans · ${stats.logs} logs · ${(stats.rawBytes / 1024 / 1024).toFixed(1)} MiB retained / ${stats.limits.retainedBytes / 1024 / 1024} MiB · ${stats.batches} / ${stats.limits.retainedBatches} batches`
      const items = byId("items")
      items.replaceChildren()
      byId("list-status").textContent = list.items.length ? `${list.items.length} ${state.mode}${list.truncated ? " · First 100 only; narrow the filters." : " received"}` : "No matching observations received."
      for (const row of list.items) {
        if (state.mode === "logs") { logRow(row, items); continue }
        const button = node("button", undefined, "local-row")
        button.type = "button"
        button.dataset.traceId = row.traceId
        button.append(node("strong", row.name || "Trace"), node("span", `${row.service || "unknown service"} · ${row.spanCount} spans · ${formatDuration(row.durationNano)} extent`, "subtle"), node("small", formatTimestamp(row.startNano), "mono subtle"), node("small", row.traceId, "mono subtle"))
        button.addEventListener("click", () => { void selectTrace(row.traceId) })
        items.append(button)
      }
    } catch (cause) { if (!controller.signal.aborted) error(cause.message) }
    finally { if (state.refresh === controller) byId("refresh").disabled = false }
  }
  byId("filters").addEventListener("submit", event => { event.preventDefault(); void refresh() })
  for (const [id, mode] of [["traces-tab", "traces"], ["logs-tab", "logs"]]) {
    byId(id).addEventListener("click", () => {
      state.mode = mode
      byId("traces-tab").setAttribute("aria-pressed", String(mode === "traces"))
      byId("logs-tab").setAttribute("aria-pressed", String(mode === "logs"))
      void refresh()
    })
  }
  return { refresh, selectTrace, selectLog }
}

if (typeof document !== "undefined") void createApp({ document, fetch: globalThis.fetch.bind(globalThis) }).refresh()
