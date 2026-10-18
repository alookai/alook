package ai.alook.android

internal class NativeBackGesture {
    private var generation = 0L
    private var href: String? = null
    private var document: String? = null
    private var stale = false
    private var pendingProgress: Float? = null

    fun start(quotedHref: String, quotedDocument: String): String {
        stale = false
        href = quotedHref
        document = quotedDocument
        pendingProgress = null
        generation += 1
        return payload("start", "0")
    }

    fun progress(value: Float): Boolean {
        if (href == null || stale || !value.isFinite()) return false
        pendingProgress = value.coerceIn(0f, 1f)
        return true
    }

    fun takeProgress(): String? {
        val progress = pendingProgress ?: return null
        pendingProgress = null
        return if (href != null && !stale) payload("progress", progress.toString()) else null
    }

    fun cancel(): String? {
        val result = if (href != null && !stale) payload("cancel", "null") else null
        reset()
        return result
    }

    fun complete(quotedHref: String, quotedDocument: String): String? {
        if (stale || href != null && (href != quotedHref || document != quotedDocument)) {
            reset()
            return null
        }
        if (href == null) {
            generation += 1
            href = quotedHref
            document = quotedDocument
        }
        val result = payload("complete", "null")
        reset()
        return result
    }

    fun invalidate() {
        if (href != null) stale = true
        href = null
        document = null
        pendingProgress = null
        generation += 1
    }

    fun reset() {
        stale = false
        href = null
        document = null
        pendingProgress = null
        generation += 1
    }

    private fun payload(type: String, progress: String) =
        "{\"type\":\"$type\",\"href\":$href,\"document\":$document,\"generation\":$generation,\"progress\":$progress}"
}
