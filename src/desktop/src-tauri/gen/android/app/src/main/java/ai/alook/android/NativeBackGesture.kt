package ai.alook.android

internal class NativeBackGesture {
    private var generation = 0L
    private var href: String? = null
    private var document: String? = null
    private var stale = false

    fun insets(quotedHref: String, quotedDocument: String, left: Int, right: Int, width: Int): String? {
        if (width <= 0 || left < 0 || right < 0 || left.toLong() + right >= width) return null
        return "{\"type\":\"insets\",\"href\":$quotedHref,\"document\":$quotedDocument,\"left\":${left.toDouble() / width},\"right\":${right.toDouble() / width}}"
    }

    fun start(quotedHref: String, quotedDocument: String) {
        stale = false
        href = quotedHref
        document = quotedDocument
        generation += 1
    }

    fun cancel() {
        reset()
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
        val result = "{\"type\":\"complete\",\"href\":$href,\"document\":$document,\"generation\":$generation}"
        reset()
        return result
    }

    fun invalidate() {
        if (href != null) stale = true
        href = null
        document = null
        generation += 1
    }

    fun reset() {
        stale = false
        href = null
        document = null
        generation += 1
    }

}
