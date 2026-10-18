package ai.alook.android

import org.junit.Assert.*
import org.junit.Test

class NativeBackGestureTest {
    private val href = "\"https://alook.ai/c/me/one\""
    private val document = "\"document-one\""

    @Test fun ignoresProgressAndCancellationWithoutStart() {
        val bridge = NativeBackGesture()
        assertFalse(bridge.progress(0.5f))
        assertNull(bridge.takeProgress())
        assertNull(bridge.cancel())
    }

    @Test fun coalescesProgressToTheLatestValueOncePerDrain() {
        val bridge = NativeBackGesture()
        bridge.start(href, document)
        assertTrue(bridge.progress(0.2f))
        assertTrue(bridge.progress(0.5f))
        assertTrue(bridge.progress(0.8f))
        assertTrue(bridge.takeProgress()!!.contains("\"progress\":0.8"))
        assertNull(bridge.takeProgress())
    }

    @Test fun clampsFiniteInputAndRejectsNonFiniteInput() {
        val bridge = NativeBackGesture()
        bridge.start(href, document)
        assertTrue(bridge.progress(-1f))
        assertTrue(bridge.takeProgress()!!.contains("\"progress\":0.0"))
        assertTrue(bridge.progress(2f))
        assertTrue(bridge.takeProgress()!!.contains("\"progress\":1.0"))
        assertFalse(bridge.progress(Float.NaN))
        assertFalse(bridge.progress(Float.POSITIVE_INFINITY))
        assertNull(bridge.takeProgress())
    }

    @Test fun cancellationRetiresQueuedProgress() {
        val bridge = NativeBackGesture()
        bridge.start(href, document)
        bridge.progress(0.8f)
        assertTrue(bridge.cancel()!!.contains("\"type\":\"cancel\""))
        assertFalse(bridge.progress(0.9f))
        assertNull(bridge.takeProgress())
        assertNull(bridge.cancel())
    }

    @Test fun completionKeepsTheOriginalDocumentAndHrefThenRetiresTheGesture() {
        val bridge = NativeBackGesture()
        bridge.start(href, document)
        bridge.progress(0.8f)
        val completed = bridge.complete(href, document)!!
        assertTrue(completed.contains("\"type\":\"complete\""))
        assertTrue(completed.contains("\"href\":$href"))
        assertTrue(completed.contains("\"document\":$document"))
        assertFalse(bridge.progress(0.9f))
        assertNull(bridge.takeProgress())
    }

    @Test fun routeOrDocumentReplacementRejectsTheOldCompletion() {
        val bridge = NativeBackGesture()
        bridge.start(href, document)
        assertNull(bridge.complete("\"https://alook.ai/c/me/two\"", document))
        bridge.start(href, document)
        assertNull(bridge.complete(href, "\"document-two\""))
    }

    @Test fun documentOrBackgroundInvalidationConsumesOnlyTheOldTerminal() {
        val bridge = NativeBackGesture()
        bridge.start(href, document)
        bridge.progress(0.8f)
        bridge.invalidate()
        bridge.invalidate()
        assertFalse(bridge.progress(0.9f))
        assertNull(bridge.takeProgress())
        assertNull(bridge.complete(href, document))
        assertNotNull(bridge.complete(href, document))
    }

    @Test fun freshStartAndCancellationRetireTheStaleFence() {
        val bridge = NativeBackGesture()
        bridge.start(href, document)
        bridge.invalidate()
        bridge.start(href, document)
        assertNotNull(bridge.complete(href, document))
        bridge.start(href, document)
        bridge.invalidate()
        bridge.cancel()
        assertNotNull(bridge.complete(href, document))
    }

    @Test fun eachStartOrDirectButtonHasAFreshGeneration() {
        val bridge = NativeBackGesture()
        val first = bridge.start(href, document)
        bridge.cancel()
        val second = bridge.start(href, document)
        assertTrue(first.contains("\"generation\":1"))
        assertFalse(second.contains("\"generation\":1"))
        bridge.complete(href, document)
        val button = bridge.complete(href, document)!!
        assertFalse(button.contains("\"generation\":1"))
    }

    @Test fun payloadsAreDataAndNeverExecuteScriptOrNavigate() {
        val bridge = NativeBackGesture()
        val messages = listOf(bridge.start(href, document), bridge.cancel()!!,
            bridge.complete(href, document)!!)
        messages.forEach {
            assertTrue(it.startsWith("{"))
            assertFalse(it.contains("dispatchEvent"))
            assertFalse(it.contains("history.back"))
            assertFalse(it.contains("evaluateJavascript"))
        }
    }
}
