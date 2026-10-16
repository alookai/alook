package ai.alook.android

import org.junit.Assert.*
import org.junit.Test

class NativeBackProgressTest {
    @Test fun ignoresProgressWithoutStart() {
        val bridge = NativeBackProgress()
        assertNull(bridge.progress(0.5f))
        assertNull(bridge.progress(null))
    }

    @Test fun clampsProgressAndRejectsNonFiniteValues() {
        val bridge = NativeBackProgress()
        bridge.start("\"https://alook.ai/c/me/one\"")
        val zero = bridge.progress(-1f)!!
        assertTrue(zero.contains("progress: 0.0"))
        assertTrue(zero.contains("started: false"))
        assertTrue(bridge.progress(2f)!!.contains("progress: 1.0"))
        assertNull(bridge.progress(Float.NaN))
        assertNull(bridge.progress(Float.POSITIVE_INFINITY))
        assertTrue(bridge.progress(0.5f)!!.contains("progress: 0.5"))
    }

    @Test fun cancellationRetiresTheCurrentGesture() {
        val bridge = NativeBackProgress()
        bridge.start("\"https://alook.ai/c/me/one\"")
        assertTrue(bridge.progress(null)!!.contains("progress: null"))
        assertNull(bridge.progress(0.8f))
        assertNull(bridge.progress(null))
    }

    @Test fun terminalOrActivityResetRetiresLateProgress() {
        val bridge = NativeBackProgress()
        bridge.start("\"https://alook.ai/c/me/one\"")
        bridge.reset()
        assertFalse(bridge.consumeTerminal())
        assertNull(bridge.progress(0.8f))
        assertNull(bridge.progress(null))
    }

    @Test fun eachStartUsesAFreshDocumentMarkerAndExactHref() {
        val bridge = NativeBackProgress()
        val first = bridge.start("\"https://alook.ai/c/me/one\"")
        val oldProgress = bridge.progress(0.5f)!!
        bridge.reset()
        val second = bridge.start("\"https://alook.ai/c/me/two?draft=1\"")
        val newProgress = bridge.progress(0.5f)!!
        assertTrue(first.contains("location.href === \"https://alook.ai/c/me/one\""))
        assertTrue(second.contains("location.href === \"https://alook.ai/c/me/two?draft=1\""))
        assertTrue(oldProgress.contains("window.__alookNativeBackGesture === 1"))
        assertFalse(newProgress.contains("window.__alookNativeBackGesture === 1"))
        assertTrue(second.contains("progress: 0"))
        assertTrue(second.contains("started: true"))
    }

    @Test fun documentOrBackgroundChangeConsumesOnlyTheOldTerminal() {
        val bridge = NativeBackProgress()
        bridge.invalidate()
        assertFalse(bridge.consumeTerminal())
        bridge.start("\"https://alook.ai/c/me/one\"")
        bridge.invalidate()
        bridge.invalidate()
        assertNull(bridge.progress(0.8f))
        assertTrue(bridge.consumeTerminal())
        assertFalse(bridge.consumeTerminal())
    }

    @Test fun freshStartOrCancellationRetiresTheStaleTerminalFence() {
        val bridge = NativeBackProgress()
        bridge.start("\"https://alook.ai/c/me/one\"")
        bridge.invalidate()
        bridge.start("\"https://alook.ai/c/me/two\"")
        assertFalse(bridge.consumeTerminal())
        bridge.start("\"https://alook.ai/c/me/two\"")
        bridge.invalidate()
        bridge.progress(null)
        assertFalse(bridge.consumeTerminal())
    }

    @Test fun scriptsOnlyEmitProgressAndNeverNavigateOrDispatchTerminalBack() {
        val bridge = NativeBackProgress()
        val scripts = listOf(bridge.start("\"http://localhost:3000/c/me\""), bridge.progress(0.4f)!!, bridge.progress(null)!!)
        scripts.forEach {
            assertTrue(it.contains("'alook:native-back-progress'"))
            assertFalse(it.contains("'alook:native-back'"))
            assertFalse(it.contains("history.back"))
            assertFalse(it.contains("goBack"))
        }
    }
}
