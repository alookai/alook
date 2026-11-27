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

    @Test
    fun pendingQueuePreservesViewerAcrossPeekAndAckAndViewerClear() {
        val first = MobilePushRoute(
            "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "message_1",
            "channel_1",
            "viewer_a",
        )
        val second = MobilePushRoute(
            "5f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "message_2",
            "channel_2",
            "viewer_b",
        )
        val queued = mobilePushPendingQueueEnqueue(
            mobilePushPendingQueueEnqueue(emptyList(), first),
            second,
        )
        val roundTripped = mobilePushPendingQueueDecode(mobilePushPendingQueueEncode(queued))
        assertEquals(listOf(first, second), roundTripped)
        assertEquals(listOf(second), mobilePushPendingQueueAck(roundTripped, first.notificationId))
        assertEquals(listOf(second), mobilePushPendingQueueClearViewer(roundTripped, "viewer_a"))
    }

    @Test
    fun launchIntentAuthorizationRejectsForgedOrUnrecordedNotifications() {
        val route = MobilePushRoute(
            "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "message_1",
            "channel_1",
            "viewer_a",
        )
        val action = mobilePushNotificationAction("ai.alook.android", route.notificationId)
        val delivered = mobilePushDeliveredIdsRecord(emptyList(), route.notificationId)
        val secret = "install-secret-uuid"

        assertTrue(
            mobilePushLaunchIntentAuthorized(
                "ai.alook.android",
                action,
                secret,
                secret,
                delivered,
                route,
            ),
        )
        assertTrue(
            mobilePushLaunchIntentAuthorized(
                "ai.alook.android",
                MOBILE_PUSH_SYSTEM_TRAY_ACTION,
                secret,
                null,
                emptyList(),
                route,
            ),
        )
        assertTrue(
            mobilePushLaunchIntentAuthorized(
                "ai.alook.android",
                MOBILE_PUSH_SYSTEM_TRAY_ACTION,
                "",
                null,
                emptyList(),
                route,
            ),
        )
        assertFalse(
            mobilePushLaunchIntentAuthorized(
                "ai.alook.android",
                action,
                "",
                "",
                delivered,
                route,
            ),
        )
        assertFalse(
            mobilePushLaunchIntentAuthorized(
                "ai.alook.android",
                null,
                secret,
                secret,
                delivered,
                route,
            ),
        )
        assertFalse(
            mobilePushLaunchIntentAuthorized(
                "ai.alook.android",
                "android.intent.action.VIEW",
                secret,
                secret,
                delivered,
                route,
            ),
        )
        assertFalse(
            mobilePushLaunchIntentAuthorized(
                "ai.alook.android",
                action,
                secret,
                "wrong-secret",
                delivered,
                route,
            ),
        )
        assertFalse(
            mobilePushLaunchIntentAuthorized(
                "ai.alook.android",
                action,
                secret,
                secret,
                emptyList(),
                route,
            ),
        )
    }

    @Test
    fun presentationScriptAndSuppressionResultMatchExpectedContract() {
        val noViewer = MobilePushRoute(
            "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
            "message_1",
            "channel_1",
        )
        assertNull(mobilePushPresentationScript(noViewer))
        val script = mobilePushPresentationScript(noViewer.copy(viewerUserId = "viewer_1"))!!
        assertTrue(script.contains("alookNativeNotificationPresentationV1"))
        assertTrue(script.contains("\"viewerUserId\":\"viewer_1\""))
        assertTrue(script.contains("\"targetId\":\"channel_1\""))
        assertTrue(mobilePushPresentationResultSuppresses("\"suppress\""))
        assertTrue(mobilePushPresentationResultSuppresses("suppress"))
        assertFalse(mobilePushPresentationResultSuppresses("\"present\""))
        assertFalse(mobilePushPresentationResultSuppresses(null))
        assertTrue(
            mobilePushNotificationTagMatchesViewer(
                mobilePushNotificationTag("viewer_1", "channel_1", noViewer.notificationId),
                "viewer_1",
            ),
        )
        assertFalse(
            mobilePushNotificationTagMatchesViewer(
                mobilePushNotificationTag("viewer_2", "channel_1", noViewer.notificationId),
                "viewer_1",
            ),
        )
    }

    @Test
    fun notificationContentPrefersDataPayloadAndFallsBackToNotificationFields() {
        assertEquals(
            "Data Title" to "Data Body",
            mobilePushNotificationContent(
                mapOf("title" to "Data Title", "body" to "Data Body"),
                "Fallback Title",
                "Fallback Body",
            ),
        )
        assertEquals(
            "Fallback Title" to "Fallback Body",
            mobilePushNotificationContent(emptyMap(), "Fallback Title", "Fallback Body"),
        )
        assertEquals(
            "Alook" to "Only Body",
            mobilePushNotificationContent(mapOf("body" to "Only Body"), null, null),
        )
        assertNull(mobilePushNotificationContent(emptyMap(), null, ""))
    }
}
