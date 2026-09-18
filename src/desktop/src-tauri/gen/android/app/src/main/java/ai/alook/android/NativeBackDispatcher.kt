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
