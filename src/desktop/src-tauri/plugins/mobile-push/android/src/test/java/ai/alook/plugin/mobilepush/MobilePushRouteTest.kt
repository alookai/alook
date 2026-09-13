package ai.alook.plugin.mobilepush

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MobilePushRouteTest {
    @Test
    fun acceptsOnlyCanonicalAllowlistedRouteValues() {
        val route = MobilePushRoute.create(
            "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "message_1",
            "channel-2",
        )
        assertEquals("message_1", route?.messageId)
        assertNull(MobilePushRoute.create("bad", "message_1", "channel-2"))
        assertNull(MobilePushRoute.create(
            "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "../message",
            "channel-2",
        ))
    }

    @Test
    fun ignoresTransportExtrasButStoresOnlyTheThreeRouteFields() {
        val route = MobilePushRoute.fromMap(mapOf(
            "notificationId" to "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "messageId" to "message_1",
            "targetId" to "channel_2",
            "from" to "transport",
        ))
        assertEquals(
            MobilePushRoute(
                "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
                "message_1",
                "channel_2",
            ),
            route,
        )
    }
}
