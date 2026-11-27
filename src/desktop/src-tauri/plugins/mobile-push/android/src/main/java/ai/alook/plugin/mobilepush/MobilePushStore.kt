package ai.alook.plugin.mobilepush

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

data class MobilePushRegistrationState(
    val currentToken: String? = null,
    val acknowledgedToken: String? = null,
) {
    fun withCurrentToken(token: String): MobilePushRegistrationState =
        if (token == currentToken) this else copy(currentToken = token)

    fun acknowledge(token: String): MobilePushRegistrationState =
        copy(acknowledgedToken = token)

    fun previousToken(): String? = acknowledgedToken?.takeIf { it != currentToken }
}

class MobilePushStore(context: Context) {
    private val preferences: SharedPreferences = context.getSharedPreferences(
        "alook.mobilePush",
        Context.MODE_PRIVATE,
    )
    private val lock = Any()

    fun installationId(): String = synchronized(lock) {
        preferences.getString(INSTALLATION_ID, null)?.let { return@synchronized it }
        val created = UUID.randomUUID().toString()
        check(preferences.edit().putString(INSTALLATION_ID, created).commit())
        created
    }

    fun registration(): MobilePushRegistrationState = synchronized(lock) {
        MobilePushRegistrationState(
            currentToken = preferences.getString(CURRENT_TOKEN, null),
            acknowledgedToken = preferences.getString(ACKNOWLEDGED_TOKEN, null),
        )
    }

    fun updateCurrentToken(token: String): Boolean = synchronized(lock) {
        require(token.length in 16..4096 && token.none { it.isISOControl() })
        val current = registration()
        val next = current.withCurrentToken(token)
        if (next == current) return@synchronized false
        check(preferences.edit().putString(CURRENT_TOKEN, next.currentToken).commit())
        true
    }

    fun acknowledge(token: String): Boolean = synchronized(lock) {
        require(token.length in 16..4096 && token.none { it.isISOControl() })
        val current = registration()
        val next = current.acknowledge(token)
        if (next == current) return@synchronized true
        check(preferences.edit().putString(ACKNOWLEDGED_TOKEN, next.acknowledgedToken).commit())
        true
    }

    fun intentSecret(): String = synchronized(lock) {
        preferences.getString(INTENT_SECRET, null)?.let { return@synchronized it }
        val created = UUID.randomUUID().toString()
        check(preferences.edit().putString(INTENT_SECRET, created).commit())
        created
    }

    fun recordDeliveredNotification(notificationId: String) = synchronized(lock) {
        val current = mobilePushDeliveredIdsDecode(preferences.getString(DELIVERED_IDS, null))
        val next = mobilePushDeliveredIdsRecord(current, notificationId)
        check(preferences.edit().putString(DELIVERED_IDS, next.joinToString("\n")).commit())
    }

    fun verifyLaunchIntent(
        packageName: String,
        action: String?,
        providedSecret: String?,
        route: MobilePushRoute,
    ): Boolean = synchronized(lock) {
        val secret = preferences.getString(INTENT_SECRET, null).orEmpty()
        val delivered = mobilePushDeliveredIdsDecode(preferences.getString(DELIVERED_IDS, null))
        mobilePushLaunchIntentAuthorized(
            packageName = packageName,
            action = action,
            expectedSecret = secret,
            providedSecret = providedSecret,
            deliveredIds = delivered,
            route = route,
        )
    }

    fun saveActivation(route: MobilePushRoute) = synchronized(lock) {
        val next = mobilePushPendingQueueEnqueue(readPendingUnlocked(), route)
        writePendingUnlocked(next)
    }

    fun peekActivation(): MobilePushRoute? = synchronized(lock) {
        readPendingUnlocked().firstOrNull()
    }

    fun ackActivation(notificationId: String): Boolean = synchronized(lock) {
        val current = readPendingUnlocked()
        val next = mobilePushPendingQueueAck(current, notificationId)
        if (next.size == current.size) return@synchronized false
        writePendingUnlocked(next)
        true
    }

    fun clearViewerPending(viewerUserId: String) = synchronized(lock) {
        val current = readPendingUnlocked()
        val next = mobilePushPendingQueueClearViewer(current, viewerUserId)
        if (next.size != current.size) {
            writePendingUnlocked(next)
        }
    }

    private fun readPendingUnlocked(): List<MobilePushRoute> {
        val queue = mobilePushPendingQueueDecode(preferences.getString(PENDING_ACTIVATIONS, null))
        val legacy = MobilePushRoute.create(
            preferences.getString(PENDING_NOTIFICATION_ID, null),
            preferences.getString(PENDING_MESSAGE_ID, null),
            preferences.getString(PENDING_TARGET_ID, null),
            preferences.getString(PENDING_VIEWER_USER_ID, null),
        )
        if (legacy == null) return queue
        val merged = mobilePushPendingQueueEnqueue(queue, legacy)
        writePendingUnlocked(merged)
        return merged
    }

    private fun writePendingUnlocked(routes: List<MobilePushRoute>) {
        val editor = preferences.edit()
            .remove(PENDING_NOTIFICATION_ID)
            .remove(PENDING_MESSAGE_ID)
            .remove(PENDING_TARGET_ID)
            .remove(PENDING_VIEWER_USER_ID)
        if (routes.isEmpty()) {
            editor.remove(PENDING_ACTIVATIONS)
        } else {
            editor.putString(PENDING_ACTIVATIONS, mobilePushPendingQueueEncode(routes))
        }
        check(editor.commit())
    }

    companion object {
        private const val INSTALLATION_ID = "installationId"
        private const val INTENT_SECRET = "intentSecret"
        private const val DELIVERED_IDS = "deliveredNotificationIds"
        private const val CURRENT_TOKEN = "currentToken"
        private const val ACKNOWLEDGED_TOKEN = "acknowledgedToken"
        private const val PENDING_ACTIVATIONS = "pendingActivations"
        private const val PENDING_NOTIFICATION_ID = "pendingNotificationId"
        private const val PENDING_MESSAGE_ID = "pendingMessageId"
        private const val PENDING_TARGET_ID = "pendingTargetId"
        private const val PENDING_VIEWER_USER_ID = "pendingViewerUserId"
    }
}
