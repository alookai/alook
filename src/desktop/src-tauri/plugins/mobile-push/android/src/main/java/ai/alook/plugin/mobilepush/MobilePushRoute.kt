package ai.alook.plugin.mobilepush

import java.util.UUID

data class MobilePushRoute(
    val notificationId: String,
    val messageId: String,
    val targetId: String,
) {
    companion object {
        private val safeId = Regex("^[A-Za-z0-9_-]{1,128}$")

        fun create(notificationId: String?, messageId: String?, targetId: String?): MobilePushRoute? {
            if (notificationId == null || messageId == null || targetId == null) return null
            val canonicalNotificationId = try {
                UUID.fromString(notificationId).toString()
            } catch (_: IllegalArgumentException) {
                return null
            }
            if (canonicalNotificationId != notificationId.lowercase()) return null
            if (!safeId.matches(messageId) || !safeId.matches(targetId)) return null
            return MobilePushRoute(canonicalNotificationId, messageId, targetId)
        }

        fun fromMap(values: Map<String, String>): MobilePushRoute? = create(
            values["notificationId"],
            values["messageId"],
            values["targetId"],
        )
    }
}
