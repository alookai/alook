package ai.alook.android

import org.junit.Assert.*
import org.junit.Test

class NativeBackGestureTest {
    private val href = "\"https://alook.ai/c/me/one\""
    private val document = "\"document-one\""

    @Test fun publishesActualSystemInsetsAsWebViewWidthFractions() {
        val bridge = NativeBackGesture()
        val insets = bridge.insets(href, document, 24, 36, 400)!!
        assertTrue(insets.contains("\"type\":\"insets\""))
        assertTrue(insets.contains("\"document\":$document"))
        assertTrue(insets.contains("\"left\":0.06"))
        assertTrue(insets.contains("\"right\":0.09"))
        assertNull(bridge.insets(href, document, 24, 24, 0))
        assertNull(bridge.insets(href, document, -1, 24, 400))
        assertNull(bridge.insets(href, document, 24, -1, 400))
        assertNull(bridge.insets(href, document, 200, 200, 400))
    }

    @Test fun completionKeepsTheStartedDocumentWithoutProgress() {
        val bridge = NativeBackGesture()
        bridge.start(href, document)
        val completed = bridge.complete(href, document)!!
        assertTrue(completed.contains("\"type\":\"complete\""))
        assertTrue(completed.contains("\"href\":$href"))
        assertTrue(completed.contains("\"document\":$document"))
        assertFalse(completed.contains("progress"))
    }

    @Test fun routeOrDocumentReplacementRejectsTheOldCompletion() {
        val bridge = NativeBackGesture()
        bridge.start(href, document)
        assertNull(bridge.complete("\"https://alook.ai/c/me/two\"", document))
        bridge.start(href, document)
        assertNull(bridge.complete(href, "\"document-two\""))
    }

    @Test fun invalidationConsumesOnlyTheOldTerminal() {
        val bridge = NativeBackGesture()
        bridge.start(href, document)
        bridge.invalidate()
        bridge.invalidate()
        assertNull(bridge.complete(href, document))
        assertNotNull(bridge.complete(href, document))
    }

    @Test fun cancellationRetiresTheStaleFenceWithoutPayload() {
        val bridge = NativeBackGesture()
        bridge.start(href, document)
        bridge.invalidate()
        bridge.cancel()
        assertNotNull(bridge.complete(href, document))
        bridge.start(href, document)
        bridge.invalidate()
        bridge.start(href, document)
        assertNotNull(bridge.complete(href, document))
    }

    @Test fun directButtonsHaveFreshGenerationsAndNoExecutablePayload() {
        val bridge = NativeBackGesture()
        val first = bridge.complete(href, document)!!
        val second = bridge.complete(href, document)!!
        assertNotEquals(first, second)
        listOf(first, second).forEach {
            assertTrue(it.startsWith("{"))
            assertFalse(it.contains("progress"))
            assertFalse(it.contains("dispatchEvent"))
            assertFalse(it.contains("history.back"))
            assertFalse(it.contains("evaluateJavascript"))
        }
    }
}
