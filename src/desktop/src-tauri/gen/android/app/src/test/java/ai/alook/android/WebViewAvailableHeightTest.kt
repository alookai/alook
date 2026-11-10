package ai.alook.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WebViewAvailableHeightTest {
    @Test
    fun followsInsetProgressAndRestoresTheFullHostWithoutMovingTheTop() {
        val heights = listOf(0, 100, 500, 800, 500, 0).map {
            WebViewAvailableHeight.fromWindow(2400, 2400, 0, 0, it)
        }
        assertEquals(listOf(2400, 2300, 1900, 1600, 1900, 2400), heights)
        assertEquals(1500, WebViewAvailableHeight.fromWindow(2400, 1800, 100, 100, 800))
    }

    @Test
    fun doesNotSubtractImeAgainWhenTheParentAlreadyResized() {
        assertEquals(1600, WebViewAvailableHeight.fromWindow(2400, 1600, 0, 0, 800))
        val geometry = WebViewGeometry.fromWindow(1080, 2400, 0, 0, 1080, 1600, 0, 72, 0, 96)
        assertEquals(WebViewGeometry(72, 0, 0, 0, 1080, 1600), geometry)
        assertEquals("{\"top\":72,\"right\":0,\"bottom\":0,\"left\":0,\"viewportWidth\":1080,\"viewportHeight\":1600,\"caption\":false,\"windowHeight\":2400,\"windowBottom\":96}", geometry?.toJson(2400, 96))
    }

    @Test
    fun clampsCoveredAndInvalidLayoutsAcrossRotation() {
        assertEquals(0, WebViewAvailableHeight.fromWindow(800, 800, 20, 20, 1000))
        assertEquals(700, WebViewAvailableHeight.fromWindow(800, 720, 20, 20, -100))
        assertEquals(500, WebViewAvailableHeight.fromWindow(900, 900, 0, 0, 400))
        assertNull(WebViewAvailableHeight.fromWindow(0, 900, 0, 0, 0))
        assertNull(WebViewAvailableHeight.fromWindow(900, 0, 0, 0, 0))
    }

    @Test
    fun keepsFullHeightRelativeToTheWebViewOriginAndClampsItsSafeBottom() {
        val hidden = WebViewGeometry.fromWindow(1080, 900, 0, 24, 1080, 876, 0, 72, 0, 96)
        val shown = WebViewGeometry.fromWindow(1080, 900, 0, 24, 1080, 500, 0, 72, 0, 96)
        assertEquals("{\"top\":48,\"right\":0,\"bottom\":96,\"left\":0,\"viewportWidth\":1080,\"viewportHeight\":876,\"caption\":false,\"windowHeight\":876,\"windowBottom\":96}", hidden?.toJson(900, 96, 24))
        assertEquals("{\"top\":48,\"right\":0,\"bottom\":0,\"left\":0,\"viewportWidth\":1080,\"viewportHeight\":500,\"caption\":false,\"windowHeight\":876,\"windowBottom\":96}", shown?.toJson(900, 96, 24))
        val tiny = WebViewGeometry.fromWindow(5, 5, 0, 0, 5, 5, 100, 100, 100, 100)
        assertEquals("{\"top\":5,\"right\":0,\"bottom\":0,\"left\":5,\"viewportWidth\":5,\"viewportHeight\":5,\"caption\":false,\"windowHeight\":5,\"windowBottom\":0}", tiny?.toJson(5, 100))
    }

}
