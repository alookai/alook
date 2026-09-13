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

    fun saveActivation(route: MobilePushRoute) = synchronized(lock) {
        check(
            preferences.edit()
                .putString(PENDING_NOTIFICATION_ID, route.notificationId)
                .putString(PENDING_MESSAGE_ID, route.messageId)
                .putString(PENDING_TARGET_ID, route.targetId)
                .commit(),
        )
    }

    fun takeActivation(): MobilePushRoute? = synchronized(lock) {
        val route = MobilePushRoute.create(
            preferences.getString(PENDING_NOTIFICATION_ID, null),
            preferences.getString(PENDING_MESSAGE_ID, null),
            preferences.getString(PENDING_TARGET_ID, null),
        )
        if (preferences.contains(PENDING_NOTIFICATION_ID)
            || preferences.contains(PENDING_MESSAGE_ID)
            || preferences.contains(PENDING_TARGET_ID)
        ) {
            check(
                preferences.edit()
                    .remove(PENDING_NOTIFICATION_ID)
                    .remove(PENDING_MESSAGE_ID)
                    .remove(PENDING_TARGET_ID)
                    .commit(),
            )
        }
        route
    }

    companion object {
        private const val INSTALLATION_ID = "installationId"
        private const val CURRENT_TOKEN = "currentToken"
        private const val ACKNOWLEDGED_TOKEN = "acknowledgedToken"
        private const val PENDING_NOTIFICATION_ID = "pendingNotificationId"
        private const val PENDING_MESSAGE_ID = "pendingMessageId"
        private const val PENDING_TARGET_ID = "pendingTargetId"
    }
}
