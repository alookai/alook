package ai.alook.android

internal class NativeBackDispatcher(
    private val delegateToSystem: () -> Unit,
) {
    private var generation = 0L
    private var inFlight = false
    private var closed = false

    fun dispatch(evaluate: (String, (String?) -> Unit) -> Unit) {
        if (closed || inFlight) return
        inFlight = true
        val currentGeneration = ++generation
        try {
            evaluate(SCRIPT) { result -> complete(currentGeneration, result == "true") }
        } catch (_: RuntimeException) {
            complete(currentGeneration, false)
        }
    }

    fun progress(value: Float?, evaluate: (String) -> Unit) {
        if (closed || inFlight) return
        val progress = value?.takeIf { it.isFinite() }?.coerceIn(0f, 1f)
        try {
            evaluate("window.dispatchEvent(new CustomEvent('alook:native-back-progress', { detail: { progress: ${progress ?: "null"} } }));")
        } catch (_: RuntimeException) {
        }
    }

    fun close() {
        closed = true
        inFlight = false
        generation += 1
    }

    private fun complete(currentGeneration: Long, handled: Boolean) {
        if (closed || !inFlight || currentGeneration != generation) return
        inFlight = false
        if (!handled) delegateToSystem()
    }

    companion object {
        const val SCRIPT = """
            (function() {
                try {
                    var event = new Event('alook:native-back', { cancelable: true });
                    window.dispatchEvent(event);
                    return event.defaultPrevented;
                } catch (_error) {
                    return false;
                }
            })();
        """
    }
}
