package ai.alook.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeBackDispatcherTest {
    @Test
    fun progressClampsFiniteValuesAndCancellationDoesNotNavigate() {
        var fallbacks = 0
        val scripts = mutableListOf<String>()
        val dispatcher = NativeBackDispatcher { fallbacks += 1 }
        for (value in listOf(0f, 0.5f, 2f, -1f, Float.NaN, null)) {
            dispatcher.progress(value) { scripts.add(it) }
        }
        assertEquals(6, scripts.size)
        assertTrue(scripts.all { it.contains("alook:native-back-progress") })
        assertTrue(scripts[1].contains("progress: 0.5"))
        assertTrue(scripts[2].contains("progress: 1.0"))
        assertTrue(scripts[3].contains("progress: 0.0"))
        assertTrue(scripts[4].contains("progress: null"))
        assertTrue(scripts[5].contains("progress: null"))
        assertEquals(0, fallbacks)
    }

    @Test
    fun progressStopsWhileCommitIsInFlightOrDispatcherIsClosed() {
        var evaluations = 0
        val dispatcher = NativeBackDispatcher { }
        dispatcher.dispatch { _, _ -> }
        dispatcher.progress(0.5f) { evaluations += 1 }
        dispatcher.close()
        dispatcher.progress(null) { evaluations += 1 }
        assertEquals(0, evaluations)
    }

    @Test
    fun unavailableProgressEvaluationDoesNotBreakCommittedFallback() {
        var fallbacks = 0
        val dispatcher = NativeBackDispatcher { fallbacks += 1 }
        dispatcher.progress(0.5f) { throw IllegalStateException("unavailable") }
        dispatcher.dispatch { _, complete -> complete("false") }
        assertEquals(1, fallbacks)
    }

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
