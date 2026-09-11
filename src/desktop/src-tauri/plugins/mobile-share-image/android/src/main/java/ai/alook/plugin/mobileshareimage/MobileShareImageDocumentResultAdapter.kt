package ai.alook.plugin.mobileshareimage

internal interface MobileShareImageDocumentResultRegistration<Input> {
    fun launch(input: Input)
    fun unregister()
}

/**
 * Binds every Activity Result callback to the native token that created its
 * registry key. A callback must never recover identity from the coordinator's
 * current pending request: a late result from request A could otherwise be
 * mistaken for a later request B.
 */
internal class MobileShareImageDocumentResultAdapter<Input, Result>(
    private val register: (
        key: String,
        callback: (Result) -> Unit,
    ) -> MobileShareImageDocumentResultRegistration<Input>,
    private val createInput: (token: String, filename: String) -> Input,
    private val deliver: (token: String, result: Result) -> Unit,
) {
    private data class Binding<Input>(
        var registration: MobileShareImageDocumentResultRegistration<Input>? = null,
        var deliveredDuringRegistration: Boolean = false,
    )

    private val bindings = mutableMapOf<String, Binding<Input>>()

    fun restore(token: String?) {
        if (token != null) ensureRegistered(token)
    }

    fun launch(token: String, filename: String) {
        val registration = ensureRegistered(token)
        try {
            registration.launch(createInput(token, filename))
        } catch (error: Exception) {
            remove(token, registration)
            throw error
        }
    }

    fun detach() {
        val registrations = bindings.values.mapNotNull { it.registration }
        bindings.clear()
        registrations.forEach { registration -> runCatching { registration.unregister() } }
    }

    private fun ensureRegistered(token: String): MobileShareImageDocumentResultRegistration<Input> {
        bindings[token]?.registration?.let { return it }
        val binding = Binding<Input>()
        bindings[token] = binding
        val registration = try {
            register(resultKey(token)) { result ->
                try {
                    deliver(token, result)
                } finally {
                    val current = bindings[token]
                    if (current === binding) {
                        bindings.remove(token)
                        val registered = binding.registration
                        if (registered == null) binding.deliveredDuringRegistration = true
                        else runCatching { registered.unregister() }
                    }
                }
            }
        } catch (error: Exception) {
            if (bindings[token] === binding) bindings.remove(token)
            throw error
        }
        binding.registration = registration
        if (binding.deliveredDuringRegistration) {
            runCatching { registration.unregister() }
        }
        return registration
    }

    private fun remove(
        token: String,
        registration: MobileShareImageDocumentResultRegistration<Input>,
    ) {
        val current = bindings[token]
        if (current?.registration === registration) bindings.remove(token)
        runCatching { registration.unregister() }
    }

    private fun resultKey(token: String): String = "alook.mobileShareImage.document.$token"
}
