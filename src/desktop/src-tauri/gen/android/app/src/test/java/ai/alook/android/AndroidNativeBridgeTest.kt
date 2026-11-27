package ai.alook.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidNativeBridgeTest {
    @Test
    fun trustedOriginsExcludeWildcardsAndUntrustedHosts() {
        val prod = AndroidNativeBridge.allowedOriginRules(isDebug = false)
        assertEquals(setOf("https://alook.ai", "http://alook-recovery.localhost"), prod)
        assertFalse(prod.contains("*"))
        assertFalse(AndroidNativeBridge.isAllowedOrigin("http://localhost:3000", isDebug = false))
        assertTrue(AndroidNativeBridge.isAllowedOrigin("https://alook.ai", isDebug = false))
        assertTrue(AndroidNativeBridge.isAllowedOrigin("http://alook-recovery.localhost", isDebug = false))

        val debug = AndroidNativeBridge.allowedOriginRules(isDebug = true)
        assertTrue(debug.contains("http://localhost:3000"))
        assertTrue(AndroidNativeBridge.isAllowedOrigin("http://localhost:3000", isDebug = true))

        for (untrusted in listOf(
            null,
            "",
            "null",
            "about:blank",
            "http://alook.ai",
            "https://alook.ai.evil.example",
            "https://alook.ai:8443",
            "http://localhost:3001",
            "http://127.0.0.1:3000",
            "alook-recovery://localhost",
        )) {
            assertFalse("accepted $untrusted in prod", AndroidNativeBridge.isAllowedOrigin(untrusted, isDebug = false))
            assertFalse("accepted $untrusted in debug", AndroidNativeBridge.isAllowedOrigin(untrusted, isDebug = true))
        }
    }

    @Test
    fun messageParserAcceptsOnlyKnownTypesAndValidColors() {
        assertEquals(
            AndroidNativeBridge.BridgeMessage.Bootstrap,
            AndroidNativeBridge.parseMessage("""{"type":"bootstrap"}"""),
        )
        assertEquals(
            AndroidNativeBridge.BridgeMessage.Theme(dark = true, backgroundHex = "#1a2b3c"),
            AndroidNativeBridge.parseMessage("""{"type":"theme","dark":true,"background":"#1a2b3c"}"""),
        )
        assertEquals(
            AndroidNativeBridge.BridgeMessage.Theme(dark = false, backgroundHex = null),
            AndroidNativeBridge.parseMessage("""{"type":"theme","dark":false,"background":null}"""),
        )
        assertEquals(
            AndroidNativeBridge.BridgeMessage.Theme(dark = true, backgroundHex = null),
            AndroidNativeBridge.parseMessage("""{"type":"theme","dark":true,"background":"red"}"""),
        )
        assertNull(AndroidNativeBridge.parseMessage(null))
        assertNull(AndroidNativeBridge.parseMessage(""))
        assertNull(AndroidNativeBridge.parseMessage("""{"type":"theme"}"""))
        assertNull(AndroidNativeBridge.parseMessage("""{"type":"unknown","dark":true}"""))
    }

    @Test
    fun documentStartScriptGuardsTopFrameAndAvoidsLegacyGlobalBridge() {
        val script = AndroidNativeBridge.BRIDGE_AND_THEME_SCRIPT
        assertTrue(script.contains("if (window.top !== window) return;"))
        assertTrue(script.contains("window.alookNativeBridge"))
        assertTrue(script.contains("__alookNativeBridge"))
        assertTrue(script.contains("alook:keyboard-change"))
        assertTrue(script.contains("keyboard: null"))
        assertFalse(script.contains("window.AlookNative"))
    }

    @Test
    fun snapshotPayloadCombinesGeometryKeyboardAndGestureRegion() {
        val legacyPayload = AndroidNativeBridge.buildSnapshotPayload(
            geometryJson = """{"top":10,"right":0,"bottom":20,"left":0,"viewportWidth":390,"viewportHeight":844,"caption":false}""",
            systemGestureRegionJson = """{"left":24,"right":24,"width":390}""",
        )
        assertTrue(legacyPayload.contains(""""keyboard":{"resizesViewport":true}"""))
        assertTrue(legacyPayload.contains(""""viewportWidth":390"""))
        assertTrue(legacyPayload.contains(""""systemGestureRegion":{"left":24,"right":24,"width":390}"""))

        val overlayKeyboardJson = AndroidNativeBridge.KeyboardOverlayPacket(
            targetInset = 820,
            viewportWidth = 1080,
            durationMs = 250L,
            phase = "animating",
            sequence = 7L,
        ).toJson()
        val overlayPayload = AndroidNativeBridge.buildSnapshotPayload(
            geometryJson = """{"top":10,"right":0,"bottom":20,"left":0,"viewportWidth":1080,"viewportHeight":2400,"caption":false}""",
            systemGestureRegionJson = "null",
            keyboardJson = overlayKeyboardJson,
        )
        assertTrue(overlayPayload.contains(""""mode":"overlay-gpu""""))
        assertTrue(overlayPayload.contains(""""targetInset":820"""))
        assertTrue(overlayPayload.contains(""""viewportWidth":1080"""))
        assertTrue(overlayPayload.contains(""""durationMs":250"""))
        assertTrue(overlayPayload.contains(""""easing":"cubic-bezier(0.2, 0, 0, 1)""""))
        assertTrue(overlayPayload.contains(""""phase":"animating""""))
        assertTrue(overlayPayload.contains(""""sequence":7"""))
    }

    @Test
    fun keyboardOverlayPacketClampsBoundsAndResolvesImeTargets() {
        val clamped = AndroidNativeBridge.KeyboardOverlayPacket(
            targetInset = -50,
            viewportWidth = -10,
            durationMs = 5000L,
            easing = "",
            phase = "unexpected",
            sequence = -3L,
        ).toJson()
        assertEquals(
            """{"mode":"overlay-gpu","targetInset":0,"viewportWidth":0,"durationMs":1000,"easing":"cubic-bezier(0.2, 0, 0, 1)","phase":"settled","sequence":0}""",
            clamped,
        )
        assertEquals(
            """{"mode":"overlay-gpu","targetInset":0,"viewportWidth":1080,"durationMs":0,"easing":"cubic-bezier(0.2, 0, 0, 1)","phase":"settled","sequence":2}""",
            AndroidNativeBridge.settledOverlayKeyboardJson(0, 1080, 2L),
        )
        assertEquals(840, AndroidNativeBridge.resolveImeAnimationTargetInset(840, 0, 840))
        assertEquals(840, AndroidNativeBridge.resolveImeAnimationTargetInset(0, 0, 840))
        assertEquals(0, AndroidNativeBridge.resolveImeAnimationTargetInset(0, 840, 840))
        assertEquals(0, AndroidNativeBridge.resolveImeAnimationTargetInset(840, 840, 840))
    }

    @Test
    fun imeAnimationTrackerDefersSettledUntilOverlappingAnimationsDrain() {
        val tracker = AndroidNativeBridge.ImeAnimationTracker<String>()
        assertFalse(tracker.isActive)

        tracker.onPrepare("open", currentAppliedImeBottom = 0)
        assertTrue(tracker.isActive)
        assertEquals(840, tracker.onStart("open", currentAppliedImeBottom = 840, upperBoundBottom = 840))

        // Interrupt mid-open with dismiss; open's onEnd must not settle while dismiss is active.
        tracker.onPrepare("dismiss", currentAppliedImeBottom = 840)
        assertEquals(0, tracker.onStart("dismiss", currentAppliedImeBottom = 0, upperBoundBottom = 840))
        assertFalse(tracker.onEnd("open"))
        assertTrue(tracker.isActive)
        assertTrue(tracker.onEnd("dismiss"))
        assertFalse(tracker.isActive)

        // Alternate callback order: dismiss prepares before cancelled open ends.
        tracker.onPrepare("open2", currentAppliedImeBottom = 0)
        tracker.onPrepare("dismiss2", currentAppliedImeBottom = 840)
        assertFalse(tracker.onEnd("open2"))
        assertTrue(tracker.isActive)
        assertEquals(0, tracker.onStart("dismiss2", currentAppliedImeBottom = 0, upperBoundBottom = 840))
        assertTrue(tracker.onEnd("dismiss2"))
        assertFalse(tracker.isActive)

        // Unknown / duplicate onEnd and clear() behave safely.
        assertFalse(tracker.onEnd("dismiss2"))
        tracker.onPrepare("dangling", currentAppliedImeBottom = 0)
        tracker.clear()
        assertFalse(tracker.isActive)
        assertFalse(tracker.onEnd("dangling"))
    }
}
