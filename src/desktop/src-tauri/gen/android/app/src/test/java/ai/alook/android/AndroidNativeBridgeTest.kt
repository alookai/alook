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
        assertFalse(script.contains("window.AlookNative"))
    }

    @Test
    fun snapshotPayloadCombinesGeometryKeyboardAndGestureRegion() {
        val payload = AndroidNativeBridge.buildSnapshotPayload(
            geometryJson = """{"top":10,"right":0,"bottom":20,"left":0,"viewportWidth":390,"viewportHeight":844,"caption":false}""",
            systemGestureRegionJson = """{"left":24,"right":24,"width":390}""",
        )
        assertTrue(payload.contains(""""keyboard":{"resizesViewport":true}"""))
        assertTrue(payload.contains(""""viewportWidth":390"""))
        assertTrue(payload.contains(""""systemGestureRegion":{"left":24,"right":24,"width":390}"""))
    }
}
