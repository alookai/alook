package ai.alook.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SystemGestureRegionTest {
    @Test
    fun mapsWindowEdgesIntoTheActualWebView() {
        assertEquals(SystemGestureRegion(24, 36, 1080), SystemGestureRegion.fromWindow(1080, 0, 1080, 24, 36))
        assertEquals(SystemGestureRegion(0, 12, 1016), SystemGestureRegion.fromWindow(1080, 40, 1016, 24, 36))
        assertEquals(SystemGestureRegion(48, 60, 2400), SystemGestureRegion.fromWindow(2400, 0, 2400, 48, 60))
        assertEquals(SystemGestureRegion(0, 0, 1080), SystemGestureRegion.fromWindow(1080, 0, 1080, 0, 0))
    }

    @Test
    fun rejectsUnlaidOutViewsAndClampsConsumedEdges() {
        assertNull(SystemGestureRegion.fromWindow(0, 0, 1080, 24, 24))
        assertNull(SystemGestureRegion.fromWindow(1080, 0, 0, 24, 24))
        assertEquals(SystemGestureRegion(100, 0, 100), SystemGestureRegion.fromWindow(1080, 0, 100, 200, 24))
        assertEquals("{\"left\":24,\"right\":36,\"width\":1080}", SystemGestureRegion(24, 36, 1080).toJson())
    }
}
