package ai.alook.android

internal class NativeBackProgress {
    private var generation = 0L
    private var href: String? = null
    private var stale = false

    fun start(quotedHref: String): String {
        stale = false
        href = quotedHref
        generation += 1
        return "if (location.href === $quotedHref) { window.__alookNativeBackGesture = $generation; ${event("0", started = true)} }"
    }

    fun progress(value: Float?): String? {
        val target = href ?: run { if (value == null) reset(); return null }
        if (value != null && !value.isFinite()) return null
        val script = "if (location.href === $target && window.__alookNativeBackGesture === $generation) { ${event(value?.coerceIn(0f, 1f)?.toString() ?: "null")} }"
        if (value == null) reset()
        return script
    }

    fun invalidate() {
        if (href != null) stale = true
        href = null
        generation += 1
    }

    fun consumeTerminal(): Boolean {
        val consume = stale
        reset()
        return consume
    }

    fun reset() {
        stale = false
        href = null
        generation += 1
    }

    private fun event(value: String, started: Boolean = false) =
        "window.dispatchEvent(new CustomEvent('alook:native-back-progress', { detail: { progress: $value, started: $started } }));"
}
