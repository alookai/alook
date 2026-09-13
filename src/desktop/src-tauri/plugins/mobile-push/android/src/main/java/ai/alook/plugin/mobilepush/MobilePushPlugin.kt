package ai.alook.plugin.mobilepush

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.messaging.FirebaseMessaging
import java.lang.ref.WeakReference

@InvokeArg
class AcknowledgeRegistrationArgs {
    lateinit var providerToken: String
}

@InvokeArg
class MobilePushListenArgs {
    lateinit var channel: Channel
}

@InvokeArg
class MobilePushUnlistenArgs {
    var registrationId: Long = 0
}

internal fun mobilePushPermissionState(
    notificationsEnabled: Boolean,
    declaredState: String?,
): String = when {
    notificationsEnabled -> "granted"
    declaredState == PermissionState.PROMPT.toString() -> "prompt"
    else -> "denied"
}

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "permissionState"),
    ],
)
class MobilePushPlugin(private val activity: Activity) : Plugin(activity) {
    private val store = MobilePushStore(activity.applicationContext)
    private var listener: Channel? = null

    override fun load(webView: WebView) {
        super.load(webView)
        instance = WeakReference(this)
        createNotificationChannel(activity)
        intake(activity.intent)
        refreshToken()
    }

    override fun onResume() {
        super.onResume()
        intake(activity.intent)
        refreshToken()
        signal()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        activity.intent = intent
        intake(intent)
    }

    @Command
    override fun checkPermissions(invoke: Invoke) {
        resolvePermission(invoke)
    }

    @Command
    override fun requestPermissions(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || permissionState() != PermissionState.PROMPT.toString()
        ) {
            resolvePermission(invoke)
        } else {
            requestPermissionForAlias("permissionState", invoke, "permissionCallback")
        }
    }

    @PermissionCallback
    private fun permissionCallback(invoke: Invoke) {
        resolvePermission(invoke)
    }

    @Command
    fun snapshot(invoke: Invoke) {
        refreshToken()
        try {
            val registration = store.registration()
            val response = JSObject()
            response.put("installationId", store.installationId())
            response.put("platform", "android")
            response.put("providerEnvironment", "production")
            response.put("providerToken", registration.currentToken)
            response.put("previousProviderToken", registration.previousToken())
            response.put("appVersion", appVersion())
            invoke.resolve(response)
        } catch (_: Exception) {
            invoke.reject("Native push storage is unavailable", "store_unavailable")
        }
    }

    @Command
    fun acknowledgeRegistration(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(AcknowledgeRegistrationArgs::class.java)
        } catch (_: Exception) {
            invoke.reject("Registration acknowledgement is invalid", "invalid_request")
            return
        }
        try {
            if (!store.acknowledge(args.providerToken)) {
                invoke.reject("Registration token changed", "stale_token")
                return
            }
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("Native push storage is unavailable", "store_unavailable")
        }
    }

    @Command
    fun takeActivation(invoke: Invoke) {
        try {
            val route = store.takeActivation()
            if (route == null) {
                invoke.resolve()
                return
            }
            val response = JSObject()
            response.put("notificationId", route.notificationId)
            response.put("messageId", route.messageId)
            response.put("targetId", route.targetId)
            invoke.resolve(response)
        } catch (_: Exception) {
            invoke.reject("Native push storage is unavailable", "store_unavailable")
        }
    }

    @Command
    fun listen(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(MobilePushListenArgs::class.java)
        } catch (_: Exception) {
            invoke.reject("Notification listener is invalid", "invalid_request")
            return
        }
        listener = args.channel
        invoke.resolveObject(args.channel.id)
    }

    @Command
    fun unlisten(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(MobilePushUnlistenArgs::class.java)
        } catch (_: Exception) {
            invoke.reject("Notification listener is invalid", "invalid_request")
            return
        }
        if (listener?.id == args.registrationId) listener = null
        invoke.resolve()
    }

    private fun resolvePermission(invoke: Invoke) {
        val response = JSObject()
        response.put("permissionState", permissionState())
        invoke.resolve(response)
    }

    private fun permissionState(): String = mobilePushPermissionState(
        NotificationManagerCompat.from(activity).areNotificationsEnabled(),
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getPermissionState("permissionState")?.toString()
        } else {
            null
        },
    )

    private fun refreshToken() {
        try {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                if (runCatching { store.updateCurrentToken(token) }.getOrDefault(false)) signal()
            }
        } catch (_: Exception) {
            return
        }
    }

    private fun intake(intent: Intent?) {
        val route = intent?.let {
            MobilePushRoute.create(
                it.getStringExtra("notificationId"),
                it.getStringExtra("messageId"),
                it.getStringExtra("targetId"),
            )
        } ?: return
        try {
            store.saveActivation(route)
            intent.removeExtra("notificationId")
            intent.removeExtra("messageId")
            intent.removeExtra("targetId")
            signal()
        } catch (_: Exception) {
            return
        }
    }

    private fun signal() {
        runCatching { listener?.send(JSObject()) }
    }

    private fun appVersion(): String? = runCatching {
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName
    }.getOrNull()

    companion object {
        private var instance: WeakReference<MobilePushPlugin>? = null

        fun signalCurrent() {
            instance?.get()?.signal()
        }

        fun createNotificationChannel(activity: Activity) {
            createNotificationChannel(activity.applicationContext)
        }

        fun createNotificationChannel(context: android.content.Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            manager.createNotificationChannel(
                NotificationChannel(
                    AlookFirebaseMessagingService.CHANNEL_ID,
                    "Messages",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ),
            )
        }
    }
}
