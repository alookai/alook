package ai.alook.plugin.mobileshareimage

import org.junit.Assert.assertEquals
import org.junit.Test

class MobileShareImageDocumentStateTest {
    private val token = "0123456789abcdef0123456789abcdef"
    private val owner = "owner-generation"

    @Test
    fun classifiesMissingAndMismatchedPendingAsOrphan() {
        assertEquals(
            MobileShareImageDocumentDelivery.ORPHAN,
            classify(currentToken = null),
        )
        assertEquals(
            MobileShareImageDocumentDelivery.ORPHAN,
            classify(currentToken = "fedcba9876543210fedcba9876543210"),
        )
    }

    @Test
    fun classifiesCallbacksFromDetachedOrReplacedOwnerAsStale() {
        assertEquals(
            MobileShareImageDocumentDelivery.STALE,
            classify(hasOwner = false),
        )
        assertEquals(
            MobileShareImageDocumentDelivery.STALE,
            classify(callbackOwnerGeneration = "old-owner"),
        )
        assertEquals(
            MobileShareImageDocumentDelivery.STALE,
            classify(attachedOwnerGeneration = "replacement-owner"),
        )
        assertEquals(
            MobileShareImageDocumentDelivery.STALE,
            classify(currentPhase = MobileShareImageDocumentPhase.WRITING),
        )
    }

    @Test
    fun validWaitingCallbackSelectsCancelOrWriteTransition() {
        assertEquals(
            MobileShareImageDocumentDelivery.CANCEL,
            classify(successfulSelection = false),
        )
        assertEquals(
            MobileShareImageDocumentDelivery.WRITE,
            classify(successfulSelection = true),
        )
    }

    private fun classify(
        currentToken: String? = token,
        currentOwnerGeneration: String? = owner,
        currentPhase: MobileShareImageDocumentPhase? = MobileShareImageDocumentPhase.WAITING,
        attachedOwnerGeneration: String? = owner,
        hasOwner: Boolean = true,
        callbackOwnerGeneration: String = owner,
        successfulSelection: Boolean = false,
    ) = classifyMobileShareImageDocumentDelivery(
        currentToken = currentToken,
        currentOwnerGeneration = currentOwnerGeneration,
        currentPhase = currentPhase,
        attachedOwnerGeneration = attachedOwnerGeneration,
        hasOwner = hasOwner,
        callbackToken = token,
        callbackOwnerGeneration = callbackOwnerGeneration,
        successfulSelection = successfulSelection,
    )
}
