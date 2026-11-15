package ai.alook.plugin.mobileorientation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MobileOrientationTest {
    @Test fun clockwiseSensorAnglesKeepBothLandscapeDirectionsDistinct() {
        for (angle in listOf(0, 90, 180, 270)) assertEquals(angle, mobileOrientationAngle(angle, null))
    }
    @Test fun unknownDoesNotInventAnOrientation() {
        assertNull(mobileOrientationAngle(-1, null))
        assertEquals(90, mobileOrientationAngle(-1, 90))
        assertEquals(270, mobileOrientationAngle(360, 270))
    }
    @Test fun hysteresisKeepsDirectionThroughDiagonalNoiseInBothDirections() {
        for (angle in listOf(44, 46, 59)) assertEquals(0, mobileOrientationAngle(angle, 0))
        assertEquals(90, mobileOrientationAngle(61, 0))
        assertEquals(90, mobileOrientationAngle(39, 90))
        assertEquals(0, mobileOrientationAngle(29, 90))
        assertEquals(0, mobileOrientationAngle(359, 0))
    }
}
