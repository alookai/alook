package ai.alook.plugin.mobilepush

import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class AlookFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        if (runCatching { MobilePushStore(applicationContext).updateCurrentToken(token) }.getOrDefault(false)) {
            MobilePushPlugin.signalCurrent()
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val route = MobilePushRoute.fromMap(message.data) ?: return
        val content = message.notification ?: return
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return

        MobilePushPlugin.createNotificationChannel(applicationContext)
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName) ?: return
        launchIntent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        launchIntent.putExtra("notificationId", route.notificationId)
        launchIntent.putExtra("messageId", route.messageId)
        launchIntent.putExtra("targetId", route.targetId)
        val requestCode = route.notificationId.hashCode() and Int.MAX_VALUE
        val pendingIntent = PendingIntent.getActivity(
            this,
            requestCode,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(ai.alook.plugin.mobilepush.R.drawable.ic_alook_notification)
            .setContentTitle(content.title ?: "Alook")
            .setContentText(content.body ?: "New message")
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setGroup(route.targetId)
            .build()
        NotificationManagerCompat.from(this).notify(
            route.notificationId,
            requestCode,
            notification,
        )
    }

    companion object {
        const val CHANNEL_ID = "alook_messages"
    }
}
