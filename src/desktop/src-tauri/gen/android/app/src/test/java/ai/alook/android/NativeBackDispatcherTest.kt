package ai.alook.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeBackDispatcherTest {
    @Test
    fun handledBackDoesNotDelegateToSystem() {
        var fallbacks = 0
        var script = ""
        val dispatcher = NativeBackDispatcher { fallbacks += 1 }

        dispatcher.dispatch { source, complete ->
            script = source
            complete("true")
        }

        assertTrue(script.contains("alook:native-back"))
        assertTrue(script.contains("event.defaultPrevented"))
        assertEquals(0, fallbacks)
    }

    @Test
    fun unhandledNullAndEvaluationFailureDelegateToSystem() {
        var fallbacks = 0
        val dispatcher = NativeBackDispatcher { fallbacks += 1 }

        dispatcher.dispatch { _, complete -> complete("false") }
        dispatcher.dispatch { _, complete -> complete(null) }
        dispatcher.dispatch { _, _ -> throw IllegalStateException("unavailable") }

        assertEquals(3, fallbacks)
    }

    @Test
    fun duplicateDispatchIsIgnoredWhileEvaluationIsInFlight() {
        var fallbacks = 0
        var evaluations = 0
        var completeFirst: ((String?) -> Unit)? = null
        val dispatcher = NativeBackDispatcher { fallbacks += 1 }

        dispatcher.dispatch { _, complete ->
            evaluations += 1
            completeFirst = complete
        }
        dispatcher.dispatch { _, _ -> evaluations += 1 }
        completeFirst?.invoke("false")

        assertEquals(1, evaluations)
        assertEquals(1, fallbacks)
    }

    @Test
    fun closeFencesLateEvaluationAndFutureDispatches() {
        var fallbacks = 0
        var evaluations = 0
        var completeFirst: ((String?) -> Unit)? = null
        val dispatcher = NativeBackDispatcher { fallbacks += 1 }

        dispatcher.dispatch { _, complete ->
            evaluations += 1
            completeFirst = complete
        }
        dispatcher.close()
        completeFirst?.invoke("false")
        dispatcher.dispatch { _, _ -> evaluations += 1 }

        assertEquals(1, evaluations)
        assertEquals(0, fallbacks)
    }
}
