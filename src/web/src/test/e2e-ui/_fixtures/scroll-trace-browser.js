(() => {
  const GLOBAL_NAME = "__alookScrollTrace"
  const SCHEMA_VERSION = 1
  let active = null

  const round = (value) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null
  const rect = (element) => {
    if (!element) return null
    const value = element.getBoundingClientRect()
    return {
      x: round(value.x),
      y: round(value.y),
      width: round(value.width),
      height: round(value.height),
      top: round(value.top),
      right: round(value.right),
      bottom: round(value.bottom),
      left: round(value.left),
    }
  }
  const boundedPush = (array, value, max) => {
    if (array.length < max) array.push(value)
  }
  const descriptorFor = (target, name) => {
    let owner = target
    while (owner) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor) return { descriptor, owner }
      owner = Object.getPrototypeOf(owner)
    }
    return null
  }
  const descriptorShape = (descriptor) => descriptor ? {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    writable: descriptor.writable ?? null,
    accessor: typeof descriptor.get === "function" || typeof descriptor.set === "function",
  } : null
  const stackFingerprint = () => {
    const lines = (new Error().stack ?? "")
      .split("\n")
      .slice(3, 9)
      .map((line) => line
        .replace(/https?:\/\/[^/\s)]+/g, "<origin>")
        .replace(/([?#])[^\s)]+/g, "")
        .replace(/[A-Za-z0-9_-]{32,}/g, "<id>"))
    const sanitized = lines.join("\n")
    let hash = 2166136261
    for (let index = 0; index < sanitized.length; index += 1) {
      hash ^= sanitized.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return { fingerprint: (hash >>> 0).toString(16).padStart(8, "0"), stack: sanitized }
  }
  const patchProperty = (target, name, onCall) => {
    const effective = descriptorFor(target, name)
    const own = Object.getOwnPropertyDescriptor(target, name)
    if (
      !effective
      || !effective.descriptor.configurable
      || typeof effective.descriptor.get !== "function"
      || typeof effective.descriptor.set !== "function"
    ) {
      return {
        capability: { supported: false, descriptor: descriptorShape(effective?.descriptor) },
        restore: () => {},
      }
    }
    const original = effective.descriptor
    Object.defineProperty(target, name, {
      configurable: original.configurable,
      enumerable: original.enumerable,
      get() {
        return Reflect.apply(original.get, this, [])
      },
      set(value) {
        onCall(name, [value])
        return Reflect.apply(original.set, this, [value])
      },
    })
    return {
      capability: { supported: true, descriptor: descriptorShape(original) },
      restore: () => {
        if (own) Object.defineProperty(target, name, own)
        else delete target[name]
      },
    }
  }
  const patchMethod = (target, name, onCall) => {
    const effective = descriptorFor(target, name)
    const own = Object.getOwnPropertyDescriptor(target, name)
    if (
      !effective
      || !effective.descriptor.configurable
      || typeof effective.descriptor.value !== "function"
    ) {
      return {
        capability: { supported: false, descriptor: descriptorShape(effective?.descriptor) },
        restore: () => {},
      }
    }
    const original = effective.descriptor
    const originalMethod = original.value
    Object.defineProperty(target, name, {
      configurable: original.configurable,
      enumerable: original.enumerable,
      writable: original.writable,
      value: function (...args) {
        onCall(name, args)
        return Reflect.apply(originalMethod, this, args)
      },
    })
    return {
      capability: { supported: true, descriptor: descriptorShape(original) },
      restore: () => {
        if (own) Object.defineProperty(target, name, own)
        else delete target[name]
      },
    }
  }
  const waitForElement = (selector, timeoutMs) => new Promise((resolve, reject) => {
    const existing = document.querySelector(selector)
    if (existing) {
      resolve(existing)
      return
    }
    const timeout = window.setTimeout(() => {
      observer.disconnect()
      reject(new Error(`scroll trace target not found: ${selector}`))
    }, timeoutMs)
    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector)
      if (!element) return
      window.clearTimeout(timeout)
      observer.disconnect()
      resolve(element)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  })
  const pillState = () => {
    const element = document.querySelector('[data-testid="community-scroll-to-present"]')
    if (!element) return { mode: null, count: 0, label: null }
    const label = element.getAttribute("aria-label") ?? ""
    const count = Number(label.match(/(\d+)/)?.[1] ?? 0)
    return {
      mode: label.startsWith("Jump to present") ? "jump" : "scroll",
      count,
      label,
    }
  }
  const loaderState = (content) => {
    const candidates = Array.from(content?.querySelectorAll(".h-8") ?? [])
    const top = candidates.find((element) => {
      const text = element.textContent ?? ""
      return text === "" || text.includes("Loading older messages")
    }) ?? null
    const bottom = candidates.find((element) =>
      (element.textContent ?? "").includes("Loading newer messages")) ?? null
    return {
      top: { mounted: !!top, loading: !!top?.textContent?.includes("Loading"), rect: rect(top) },
      bottom: { mounted: !!bottom, loading: !!bottom?.textContent?.includes("Loading"), rect: rect(bottom) },
    }
  }
  const rowSnapshot = (scroller, estimates) => {
    const rootRect = scroller.getBoundingClientRect()
    const wrappers = Array.from(scroller.querySelectorAll("[data-index]"))
    const rows = wrappers.map((wrapper) => {
      const index = Number(wrapper.getAttribute("data-index"))
      const message = wrapper.querySelector("[data-msg-id]")
      const id = message?.getAttribute("data-msg-id")
        ?? (wrapper.querySelector("[data-new-divider]") ? "new-divider" : `structural:${index}`)
      const value = wrapper.getBoundingClientRect()
      return {
        index,
        id,
        top: round(value.top),
        bottom: round(value.bottom),
        height: round(value.height),
        estimatedHeight: id in estimates ? estimates[id] : null,
        visible: value.bottom > rootRect.top && value.top < rootRect.bottom,
      }
    }).sort((left, right) => left.index - right.index)
    const visible = rows.filter((row) => row.visible)
    return {
      rows,
      domIds: rows.map((row) => row.id),
      renderedRange: rows.length ? [rows[0].index, rows.at(-1).index] : null,
      visibleRange: visible.length ? [visible[0].index, visible.at(-1).index] : null,
      firstVisibleId: visible[0]?.id ?? null,
      firstVisibleOffset: visible.length ? round(visible[0].top - rootRect.top) : null,
      lastVisibleId: visible.at(-1)?.id ?? null,
    }
  }
  const selfTest = () => {
    const receivers = []
    const proto = {}
    let stored = 2
    Object.defineProperty(proto, "value", {
      configurable: true,
      enumerable: false,
      get() {
        receivers.push(this)
        return stored
      },
      set(value) {
        receivers.push(this)
        if (value < 0) throw new RangeError("negative")
        stored = value
      },
    })
    Object.defineProperty(proto, "call", {
      configurable: true,
      enumerable: true,
      writable: false,
      value(delta) {
        if (delta < 0) throw new RangeError("negative method")
        return this.base + delta
      },
    })
    const target = Object.create(proto)
    target.base = 5
    const calls = []
    const propertyPatch = patchProperty(target, "value", (name, args) => calls.push([name, args]))
    const methodPatch = patchMethod(target, "call", (name, args) => calls.push([name, args]))
    target.value = 7
    const getterValue = target.value
    const methodValue = target.call(3)
    let setterError = null
    let methodError = null
    try { target.value = -1 } catch (error) { setterError = error.name }
    try { target.call(-1) } catch (error) { methodError = error.name }
    propertyPatch.restore()
    methodPatch.restore()
    const unsupported = {}
    Object.defineProperty(unsupported, "value", {
      configurable: false,
      get: () => 1,
      set: () => {},
    })
    const unsupportedPatch = patchProperty(unsupported, "value", () => {})
    return {
      getterValue,
      methodValue,
      setterError,
      methodError,
      receiverPreserved: receivers.every((receiver) => receiver === target),
      calls: calls.map(([name, args]) => [name, [...args]]),
      propertyDescriptor: propertyPatch.capability.descriptor,
      methodDescriptor: methodPatch.capability.descriptor,
      restored: !Object.hasOwn(target, "value") && !Object.hasOwn(target, "call"),
      unsupportedUntouched: !unsupportedPatch.capability.supported && unsupported.value === 1,
    }
  }

  const start = async (options) => {
    if (active) throw new Error("scroll trace already active")
    const selector = `[data-testid="${options.scrollerTestId}"]`
    const scroller = await waitForElement(selector, options.targetTimeoutMs ?? 20_000)
    const frames = []
    const writes = []
    const measurements = []
    const marks = []
    const externalEvents = []
    const restorers = []
    const listeners = []
    const estimates = options.estimatedSizes ?? {}
    const maxFrames = options.maxFrames ?? 2400
    const maxEvents = options.maxEvents ?? 4000
    const startedAt = performance.now()
    let frameId = 0
    let frame = 0
    let finalStimulusAt = null
    let finalStimulusFrame = null
    let stableFrames = 0
    let previousSignature = null
    let status = "recording"
    let programmaticScrollInProgress = false
    let programmaticTimer = 0
    let measurementRevision = 0
    let writerRevision = 0
    let currentMark = "start"
    let resolveFinished
    const finished = new Promise((resolve) => { resolveFinished = resolve })
    const addListener = (target, name, handler, optionsValue) => {
      target.addEventListener(name, handler, optionsValue)
      listeners.push(() => target.removeEventListener(name, handler, optionsValue))
    }
    const recordExternal = (type, detail = null) => boundedPush(externalEvents, {
      timestamp: round(performance.now()),
      type,
      detail,
    }, maxEvents)
    const recordWriter = (method, args) => {
      const stack = stackFingerprint()
      writerRevision += 1
      if (method === "scrollTo" || method === "scrollBy") {
        const first = args[0]
        const behavior = typeof first === "object" && first ? first.behavior : undefined
        if (behavior === "smooth") {
          programmaticScrollInProgress = true
          window.clearTimeout(programmaticTimer)
          programmaticTimer = window.setTimeout(() => {
            programmaticScrollInProgress = false
          }, 800)
        }
      }
      boundedPush(writes, {
        timestamp: round(performance.now()),
        frame,
        method,
        args: args.map((value) => typeof value === "number" ? round(value) : value),
        mark: currentMark,
        fingerprint: stack.fingerprint,
        stack: stack.stack,
      }, maxEvents)
    }
    const capabilities = {}
    for (const name of ["scrollTop"]) {
      const patch = patchProperty(scroller, name, recordWriter)
      capabilities[name] = patch.capability
      restorers.push(patch.restore)
    }
    for (const name of ["scrollTo", "scrollBy"]) {
      const patch = patchMethod(scroller, name, recordWriter)
      capabilities[name] = patch.capability
      restorers.push(patch.restore)
    }
    const content = scroller.querySelector("[data-message-list-content]")
    const composer = document.querySelector('[data-testid="community-composer-shell"]')
    const observedRows = new Set()
    const resizeObserver = new ResizeObserver((entries) => {
      measurementRevision += 1
      for (const entry of entries) {
        const wrapper = entry.target.closest?.("[data-index]") ?? entry.target
        const message = wrapper.querySelector?.("[data-msg-id]")
        const rawIndex = Number(wrapper.getAttribute?.("data-index"))
        boundedPush(measurements, {
          timestamp: round(performance.now()),
          frame,
          id: message?.getAttribute("data-msg-id") ?? null,
          index: Number.isFinite(rawIndex) ? rawIndex : null,
          height: round(entry.target.getBoundingClientRect().height),
        }, maxEvents)
      }
    })
    const observeRows = () => {
      for (const row of scroller.querySelectorAll("[data-index]")) {
        if (observedRows.has(row)) continue
        observedRows.add(row)
        resizeObserver.observe(row)
      }
    }
    resizeObserver.observe(scroller)
    if (content) resizeObserver.observe(content)
    if (composer) resizeObserver.observe(composer)
    observeRows()
    const mutationObserver = new MutationObserver(observeRows)
    mutationObserver.observe(scroller, { childList: true, subtree: true })
    addListener(scroller, "scroll", () => recordExternal("scroll", round(scroller.scrollTop)), { passive: true })
    addListener(scroller, "wheel", (event) => recordExternal("wheel", { x: round(event.deltaX), y: round(event.deltaY) }), { passive: true })
    addListener(scroller, "touchstart", () => recordExternal("touchstart"), { passive: true })
    addListener(scroller, "touchmove", () => recordExternal("touchmove"), { passive: true })
    addListener(scroller, "scrollend", () => {
      programmaticScrollInProgress = false
      recordExternal("scrollend")
    }, { passive: true })
    const safeControlKeys = new Set([
      "Enter",
      "Backspace",
      "Delete",
      "Tab",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "CapsLock",
    ])
    addListener(window, "keydown", (event) => recordExternal(
      "keydown",
      event.key.length === 1 ? "printable" : safeControlKeys.has(event.key) ? event.key : "control",
    ), { passive: true })
    addListener(window, "resize", () => recordExternal("resize", { width: innerWidth, height: innerHeight }), { passive: true })

    const sample = () => {
      frame += 1
      const currentContent = scroller.querySelector("[data-message-list-content]")
      const currentComposer = document.querySelector('[data-testid="community-composer-shell"]')
      const currentAccessoryRail = document.querySelector('[data-testid="community-composer-accessory-rail"]')
      const rows = rowSnapshot(scroller, estimates)
      const rootRect = scroller.getBoundingClientRect()
      const tail = rows.rows.at(-1)
      const loaders = loaderState(currentContent)
      const pill = pillState()
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      const sampleValue = {
        frame,
        timestamp: round(performance.now()),
        scrollTop: round(scroller.scrollTop),
        scrollHeight: round(scroller.scrollHeight),
        clientHeight: round(scroller.clientHeight),
        browserMax: round(max),
        distanceToEnd: round(max - scroller.scrollTop),
        programmaticScrollInProgress,
        scrollerRect: rect(scroller),
        contentRect: rect(currentContent),
        composerRect: rect(currentComposer),
        accessoryRailRect: rect(currentAccessoryRail),
        tailGap: tail ? round(rootRect.bottom - tail.bottom) : null,
        newDividerRect: rect(scroller.querySelector("[data-new-divider]")),
        loaders,
        pill,
        renderedRange: rows.renderedRange,
        visibleRange: rows.visibleRange,
        firstVisibleId: rows.firstVisibleId,
        firstVisibleOffset: rows.firstVisibleOffset,
        lastVisibleId: rows.lastVisibleId,
        domIds: rows.domIds,
        rows: rows.rows,
        mark: currentMark,
        writerRevision,
        measurementRevision,
      }
      boundedPush(frames, sampleValue, maxFrames)
      if (finalStimulusAt !== null) {
        const signature = JSON.stringify([
          sampleValue.scrollTop,
          sampleValue.scrollHeight,
          sampleValue.clientHeight,
          sampleValue.firstVisibleId,
          sampleValue.firstVisibleOffset,
          sampleValue.tailGap,
          sampleValue.domIds,
          writerRevision,
          measurementRevision,
        ])
        stableFrames = signature === previousSignature ? stableFrames + 1 : 0
        previousSignature = signature
        const elapsed = performance.now() - finalStimulusAt
        const elapsedFrames = frame - finalStimulusFrame
        if (stableFrames >= 3) {
          status = "stable"
          resolveFinished()
          return
        }
        if (elapsed >= (options.settlementTimeoutMs ?? 2000) || elapsedFrames >= (options.settlementFrameCap ?? 120)) {
          status = "settlementTimedOut"
          resolveFinished()
          return
        }
      }
      if (frames.length >= maxFrames) {
        status = "settlementTimedOut"
        resolveFinished()
        return
      }
      frameId = requestAnimationFrame(sample)
    }
    frameId = requestAnimationFrame(sample)

    const mark = (name, detail = {}) => {
      currentMark = name
      const value = {
        timestamp: round(performance.now()),
        frame,
        name,
        dataTransitionSource: detail.dataTransitionSource ?? null,
        detail: detail.detail ?? null,
        preEventDistanceToEnd: round(Math.max(0, scroller.scrollHeight - scroller.clientHeight) - scroller.scrollTop),
        programmaticScrollInProgress,
      }
      boundedPush(marks, value, maxEvents)
      if (name === "final-stimulus") {
        finalStimulusAt = performance.now()
        finalStimulusFrame = frame
        stableFrames = 0
        previousSignature = null
      }
      return value
    }
    const cleanup = () => {
      cancelAnimationFrame(frameId)
      clearTimeout(programmaticTimer)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
      for (const remove of listeners.splice(0)) remove()
      for (const restore of restorers.reverse()) restore()
    }
    active = {
      capabilities,
      mark,
      finished,
      finish: async () => {
        await finished
        const result = {
          schemaVersion: SCHEMA_VERSION,
          scenario: options.scenario,
          commandDirection: options.commandDirection ?? null,
          identity: options.identity,
          startedAt: round(startedAt),
          endedAt: round(performance.now()),
          status,
          capabilities,
          marks,
          frames,
          writes,
          measurements,
          externalEvents,
          dropped: {
            frames: Math.max(0, frame - frames.length),
            writes: Math.max(0, writerRevision - writes.length),
          },
        }
        cleanup()
        active = null
        delete globalThis[GLOBAL_NAME]
        return result
      },
      abort: () => {
        cleanup()
        active = null
        delete globalThis[GLOBAL_NAME]
      },
    }
    mark("start")
    return capabilities
  }

  globalThis[GLOBAL_NAME] = {
    schemaVersion: SCHEMA_VERSION,
    selfTest,
    start,
    mark: (name, detail) => {
      if (!active) throw new Error("scroll trace is not active")
      return active.mark(name, detail)
    },
    finish: () => {
      if (!active) throw new Error("scroll trace is not active")
      return active.finish()
    },
    abort: () => active?.abort(),
  }
})()
