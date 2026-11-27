package ai.alook.plugin.mobilepush

import java.security.MessageDigest
import java.util.UUID

internal const val MOBILE_PUSH_NOTIFICATION_AUTO_CANCEL = false
internal const val MOBILE_PUSH_MAX_PENDING_ACTIVATIONS = 32
internal const val MOBILE_PUSH_MAX_DELIVERED_IDS = 256
internal const val EXTRA_INTENT_SECRET = "alookIntentSecret"
internal const val MOBILE_PUSH_SYSTEM_TRAY_ACTION = "android.intent.action.MAIN"

internal fun mobilePushNotificationRequestCode(notificationId: String): Int =
    notificationId.hashCode() and Int.MAX_VALUE

internal fun mobilePushNotificationAction(packageName: String, notificationId: String): String =
    "$packageName.mobilepush.notification.$notificationId"

internal fun mobilePushPresentationScript(route: MobilePushRoute): String? {
    val viewer = route.viewerUserId ?: return null
    if (!validMobilePushTargetId(viewer) || !validMobilePushTargetId(route.targetId)) return null
    val identity = "{\"viewerUserId\":\"$viewer\",\"targetId\":\"${route.targetId}\"}"
    return "(()=>{try{return window.alookNativeNotificationPresentationV1?.($identity)===true?'suppress':'present'}catch{return 'present'}})()"
}

internal fun mobilePushPresentationResultSuppresses(rawResult: String?): Boolean =
    rawResult == "\"suppress\"" || rawResult == "suppress"

internal fun mobilePushNotificationContent(
    data: Map<String, String>,
    fallbackTitle: String?,
    fallbackBody: String?,
): Pair<String, String>? {
    val title = data["title"]?.takeIf { it.isNotBlank() }
        ?: fallbackTitle?.takeIf { it.isNotBlank() }
    val body = data["body"]?.takeIf { it.isNotBlank() }
        ?: fallbackBody?.takeIf { it.isNotBlank() }
    if (title == null && body == null) return null
    return (title ?: "Alook") to (body ?: "New message")
}

internal fun mobilePushPendingQueueDecode(raw: String?): List<MobilePushRoute> {
    if (raw.isNullOrEmpty()) return emptyList()
    return raw.lineSequence()
        .filter { it.isNotEmpty() }
        .mapNotNull { line ->
            val parts = line.split('|')
            if (parts.size != 4) return@mapNotNull null
            MobilePushRoute.create(
                parts[0],
                parts[1],
                parts[2],
                parts[3].ifEmpty { null },
            )
        }
        .toList()
        .takeLast(MOBILE_PUSH_MAX_PENDING_ACTIVATIONS)
}

internal fun mobilePushPendingQueueEncode(routes: List<MobilePushRoute>): String =
    routes.takeLast(MOBILE_PUSH_MAX_PENDING_ACTIVATIONS)
        .joinToString("\n") { route ->
            "${route.notificationId}|${route.messageId}|${route.targetId}|${route.viewerUserId.orEmpty()}"
        }

internal fun mobilePushPendingQueueEnqueue(
    current: List<MobilePushRoute>,
    route: MobilePushRoute,
): List<MobilePushRoute> {
    if (current.any { it.notificationId == route.notificationId }) return current
    return (current + route).takeLast(MOBILE_PUSH_MAX_PENDING_ACTIVATIONS)
}

internal fun mobilePushPendingQueueAck(
    current: List<MobilePushRoute>,
    notificationId: String,
): List<MobilePushRoute> =
    current.filterNot { it.notificationId == notificationId.lowercase() }

internal fun mobilePushPendingQueueClearViewer(
    current: List<MobilePushRoute>,
    viewerUserId: String,
): List<MobilePushRoute> =
    current.filterNot { it.viewerUserId == viewerUserId }

internal fun mobilePushDeliveredIdsDecode(raw: String?): List<String> {
    if (raw.isNullOrEmpty()) return emptyList()
    return raw.lineSequence()
        .mapNotNull { MobilePushRoute.create(it, "message", "target")?.notificationId }
        .distinct()
        .toList()
        .takeLast(MOBILE_PUSH_MAX_DELIVERED_IDS)
}

internal fun mobilePushDeliveredIdsRecord(current: List<String>, notificationId: String): List<String> {
    val canonical = MobilePushRoute.create(notificationId, "message", "target")?.notificationId
        ?: return current
    return (current.filterNot { it == canonical } + canonical).takeLast(MOBILE_PUSH_MAX_DELIVERED_IDS)
}

internal fun mobilePushLaunchIntentAuthorized(
    packageName: String,
    action: String?,
    expectedSecret: String,
    providedSecret: String?,
    deliveredIds: Collection<String>,
    route: MobilePushRoute,
): Boolean {
    if (action == MOBILE_PUSH_SYSTEM_TRAY_ACTION) return true
    if (action != mobilePushNotificationAction(packageName, route.notificationId)) return false
    if (providedSecret.isNullOrEmpty() || expectedSecret.isEmpty()) return false
    if (!MessageDigest.isEqual(
            expectedSecret.toByteArray(Charsets.UTF_8),
            providedSecret.toByteArray(Charsets.UTF_8),
        )
    ) {
        return false
    }
    return deliveredIds.contains(route.notificationId)
}

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

internal fun mobilePushNotificationTagMatchesViewer(
    value: String?,
    viewerUserId: String,
): Boolean {
    if (!validMobilePushTargetId(viewerUserId)) return false
    return parseMobilePushNotificationTag(value)?.viewerUserId == viewerUserId
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
