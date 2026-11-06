package ai.alook.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WebViewGeometryTest {
    @Test
    fun publishesFourEdgesAndDimensionsInTheSamePhysicalCoordinates() {
        assertEquals(WebViewGeometry(72, 24, 96, 18, 1080, 2400),
            WebViewGeometry.fromWindow(1080, 2400, 0, 0, 1080, 2400, 18, 72, 24, 96))
        assertEquals(WebViewGeometry(0, 12, 20, 0, 1016, 2300),
            WebViewGeometry.fromWindow(1080, 2400, 40, 24, 1016, 2300, 18, 20, 36, 96))
        assertEquals(WebViewGeometry(0, 0, 0, 0, 2000, 900),
            WebViewGeometry.fromWindow(2000, 900, 0, 0, 2000, 900, 0, 0, 0, 0))
    }

    @Test
    fun rejectsUnlaidOutViewsAndClampsOverlappingBands() {
        assertNull(WebViewGeometry.fromWindow(0, 900, 0, 0, 500, 900, 0, 0, 0, 0))
        assertNull(WebViewGeometry.fromWindow(500, 900, 0, 0, 500, 0, 0, 0, 0, 0))
        assertEquals(WebViewGeometry(5, 0, 0, 5, 5, 5),
            WebViewGeometry.fromWindow(5, 5, 0, 0, 5, 5, 100, 100, 100, 100))
        assertEquals("{\"top\":72,\"right\":24,\"bottom\":96,\"left\":18,\"viewportWidth\":1080,\"viewportHeight\":2400,\"caption\":false}",
            WebViewGeometry(72, 24, 96, 18, 1080, 2400).toJson())
    }
}
