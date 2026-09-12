package ai.alook.plugin.mobilepush

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MobilePushStoreCoreTest {
    @Test
    fun permissionStateHasOnlyTheThreeWebContractValues() {
        assertEquals("granted", mobilePushPermissionState(true, "prompt"))
        assertEquals("prompt", mobilePushPermissionState(false, "prompt"))
        assertEquals("denied", mobilePushPermissionState(false, "prompt-with-rationale"))
        assertEquals("denied", mobilePushPermissionState(false, "denied"))
        assertEquals("denied", mobilePushPermissionState(false, null))
    }

    @Test
    fun successfulPostedTokenBecomesProofAcrossAConcurrentRotation() {
        val t0 = "token-00000000000"
        val t1 = "token-11111111111"
        val t2 = "token-22222222222"

        val initial = MobilePushRegistrationState(currentToken = t0).acknowledge(t0)
        assertNull(initial.previousToken())

        val failedT1 = initial.withCurrentToken(t1)
        assertEquals(t0, failedT1.previousToken())

        val failedT2 = failedT1.withCurrentToken(t2)
        assertEquals(t0, failedT2.previousToken())
        val acknowledgedT1 = failedT2.acknowledge(t1)
        assertEquals(t1, acknowledgedT1.previousToken())

        val acknowledgedT2 = acknowledgedT1.acknowledge(t2)
        assertNull(acknowledgedT2.previousToken())
        assertEquals(t2, acknowledgedT2.acknowledgedToken)
    }
}
