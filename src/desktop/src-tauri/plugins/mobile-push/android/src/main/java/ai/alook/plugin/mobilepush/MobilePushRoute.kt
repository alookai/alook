package ai.alook.plugin.mobilepush

import java.util.UUID

internal const val MOBILE_PUSH_NOTIFICATION_AUTO_CANCEL = false

internal fun mobilePushNotificationRequestCode(notificationId: String): Int =
    notificationId.hashCode() and Int.MAX_VALUE

internal fun mobilePushNotificationAction(packageName: String, notificationId: String): String =
    "$packageName.mobilepush.notification.$notificationId"

data class MobilePushNotificationTag(
    val viewerUserId: String,
    val targetId: String,
    val notificationId: String,
)

internal fun mobilePushNotificationTag(
    viewerUserId: String,
    targetId: String,
    notificationId: String,
): String = "alook:v2:$viewerUserId:$targetId:$notificationId"

internal fun validMobilePushTargetId(value: String): Boolean =
    Regex("^[A-Za-z0-9_-]{1,128}$").matches(value)

internal fun parseMobilePushNotificationTag(value: String?): MobilePushNotificationTag? {
    if (value == null) return null
    val parts = value.split(':')
    if (parts.size != 5 || parts[0] != "alook" || parts[1] != "v2") return null
    val route = MobilePushRoute.create(parts[4], "message", parts[3], parts[2]) ?: return null
    return MobilePushNotificationTag(
        route.viewerUserId ?: return null,
        route.targetId,
        route.notificationId,
    )
}

internal fun mobilePushNotificationTagMatchesConversation(
    value: String?,
    viewerUserId: String,
    targetId: String,
): Boolean {
    if (!validMobilePushTargetId(viewerUserId) || !validMobilePushTargetId(targetId)) return false
    val parsed = parseMobilePushNotificationTag(value) ?: return false
    return parsed.viewerUserId == viewerUserId && parsed.targetId == targetId
}

private fun legacyMobilePushNotificationId(value: String?): String? {
    if (value == null) return null
    val parts = value.split(':')
    if (parts.size != 3 || parts[0] != "alook" || !validMobilePushTargetId(parts[1])) return null
    return MobilePushRoute.create(parts[2], "message", parts[1])?.notificationId
}

internal fun mobilePushNotificationTagMatchesNotification(
    value: String?,
    notificationId: String,
): Boolean {
    val expected = MobilePushRoute.create(notificationId, "message", "target")?.notificationId
        ?: return false
    if (value == expected) return true
    return parseMobilePushNotificationTag(value)?.notificationId == expected
        || legacyMobilePushNotificationId(value) == expected
}

data class MobilePushRoute(
    val notificationId: String,
    val messageId: String,
    val targetId: String,
    val viewerUserId: String? = null,
) {
    companion object {
        fun create(
            notificationId: String?,
            messageId: String?,
            targetId: String?,
            viewerUserId: String? = null,
        ): MobilePushRoute? {
            if (notificationId == null || messageId == null || targetId == null) return null
            val canonicalNotificationId = try {
                UUID.fromString(notificationId).toString()
            } catch (_: IllegalArgumentException) {
                return null
            }
            if (canonicalNotificationId != notificationId.lowercase()) return null
            if (!validMobilePushTargetId(messageId) || !validMobilePushTargetId(targetId)) return null
            if (viewerUserId != null && !validMobilePushTargetId(viewerUserId)) return null
            return MobilePushRoute(canonicalNotificationId, messageId, targetId, viewerUserId)
        }

        fun fromMap(values: Map<String, String>): MobilePushRoute? = create(
            values["notificationId"],
            values["messageId"],
            values["targetId"],
            values["viewerUserId"],
        )
    }
}
