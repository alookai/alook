package ai.alook.plugin.mobilepush

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobilePushRouteTest {
    @Test
    fun derivesOneStableNonNegativeNotificationRequestCode() {
        val notificationId = "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e"
        assertEquals(
            mobilePushNotificationRequestCode(notificationId),
            mobilePushNotificationRequestCode(notificationId),
        )
        assertTrue(mobilePushNotificationRequestCode(notificationId) >= 0)
    }

    @Test
    fun keepsPendingIntentIdentityExactAcrossRequestCodeCollisions() {
        val first = "4f5dff4f-8ecf-4e12-8df0-09deeca44cad"
        val second = "f0880472-8b15-4842-a905-c57cb4b94702"
        assertEquals(
            mobilePushNotificationRequestCode(first),
            mobilePushNotificationRequestCode(second),
        )
        assertTrue(
            mobilePushNotificationAction("ai.alook.android", first) !=
                mobilePushNotificationAction("ai.alook.android", second),
        )
    }

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
