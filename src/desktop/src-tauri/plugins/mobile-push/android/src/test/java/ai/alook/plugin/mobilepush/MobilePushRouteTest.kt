package ai.alook.plugin.mobilepush

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobilePushRouteTest {
    @Test
    fun keepsTappedNotificationUntilValidatedDestinationDismissal() {
        assertFalse(MOBILE_PUSH_NOTIFICATION_AUTO_CANCEL)
    }

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
    fun roundTripsOneUniqueConversationTagWithoutCollapsingSiblingNotifications() {
        val first = "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e"
        val second = "5f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e"
        val firstTag = mobilePushNotificationTag("viewer_1", "channel_1", first)
        val secondTag = mobilePushNotificationTag("viewer_1", "channel_1", second)

        assertEquals("alook:v2:viewer_1:channel_1:$first", firstTag)
        assertTrue(firstTag != secondTag)
        assertEquals(
            MobilePushNotificationTag("viewer_1", "channel_1", first),
            parseMobilePushNotificationTag(firstTag),
        )
    }

    @Test
    fun rejectsMalformedV2TagsWithoutGuessingLegacyValues() {
        val notificationId = "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e"
        listOf(
            notificationId,
            "alook:channel_1:$notificationId",
            "alook:v2:viewer_1:channel_1",
            "alook:v2::channel_1:$notificationId",
            "alook:v2:viewer_1::${notificationId}",
            "alook:v2:viewer_1:channel_1:",
            "alook:v2:../viewer:channel_1:$notificationId",
            "alook:v2:viewer_1:../channel:$notificationId",
            "alook:v2:viewer_1:channel_1:bad",
            "alook:v2:viewer_1:channel_1:$notificationId:extra",
        ).forEach { assertNull(parseMobilePushNotificationTag(it)) }
    }

    @Test
    fun bulkSelectionMatchesOnlyTheExactViewerAndConversation() {
        val b1 = mobilePushNotificationTag(
            "viewer_b",
            "channel_1",
            "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
        )
        val b2 = mobilePushNotificationTag(
            "viewer_b",
            "channel_1",
            "5f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
        )
        val a1 = mobilePushNotificationTag(
            "viewer_a",
            "channel_1",
            "6f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
        )
        val a2 = mobilePushNotificationTag(
            "viewer_a",
            "channel_1",
            "7f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
        )
        val other = mobilePushNotificationTag(
            "viewer_b",
            "channel_2",
            "8f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
        )

        assertTrue(mobilePushNotificationTagMatchesConversation(b1, "viewer_b", "channel_1"))
        assertTrue(mobilePushNotificationTagMatchesConversation(b2, "viewer_b", "channel_1"))
        assertFalse(mobilePushNotificationTagMatchesConversation(a1, "viewer_b", "channel_1"))
        assertFalse(mobilePushNotificationTagMatchesConversation(a2, "viewer_b", "channel_1"))
        assertFalse(mobilePushNotificationTagMatchesConversation(other, "viewer_b", "channel_1"))
        assertFalse(mobilePushNotificationTagMatchesConversation(
            "alook:channel_1:4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "viewer_b",
            "channel_1",
        ))
    }

    @Test
    fun singleIdSelectionRecognizesV2AndLegacyTagsOnlyByExactId() {
        val notificationId = "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e"
        assertTrue(mobilePushNotificationTagMatchesNotification(
            mobilePushNotificationTag("viewer_1", "channel_1", notificationId),
            notificationId,
        ))
        assertTrue(mobilePushNotificationTagMatchesNotification(
            "alook:channel_1:$notificationId",
            notificationId,
        ))
        assertTrue(mobilePushNotificationTagMatchesNotification(notificationId, notificationId))
        assertFalse(mobilePushNotificationTagMatchesNotification(
            "alook:channel_1:5f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            notificationId,
        ))
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
            "viewer_1",
        )
        assertEquals("message_1", route?.messageId)
        assertEquals("viewer_1", route?.viewerUserId)
        assertNull(MobilePushRoute.create("bad", "message_1", "channel-2", "viewer_1"))
        assertNull(MobilePushRoute.create(
            "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "../message",
            "channel-2",
            "viewer_1",
        ))
        assertNull(MobilePushRoute.create(
            "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "message_1",
            "channel-2",
            "../viewer",
        ))
    }

    @Test
    fun ignoresTransportExtrasButStoresOnlyTheThreeRouteFields() {
        val route = MobilePushRoute.fromMap(mapOf(
            "notificationId" to "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "messageId" to "message_1",
            "targetId" to "channel_2",
            "viewerUserId" to "viewer_1",
            "from" to "transport",
        ))
        assertEquals(
            MobilePushRoute(
                "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
                "message_1",
                "channel_2",
                "viewer_1",
            ),
            route,
        )
        assertEquals(null, MobilePushRoute.fromMap(mapOf(
            "notificationId" to "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "messageId" to "message_1",
            "targetId" to "channel_2",
        ))?.viewerUserId)
    }
}
