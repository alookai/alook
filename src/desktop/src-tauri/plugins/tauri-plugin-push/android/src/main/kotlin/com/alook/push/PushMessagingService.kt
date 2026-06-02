package com.alook.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import android.util.Log

class PushMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        Log.d("AlookPush", "Message received: ${remoteMessage.data}")
        PushPlugin.instance?.onMessageReceived(remoteMessage)
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.d("AlookPush", "New FCM token: $token")
        PushPlugin.instance?.onTokenRefresh(token)
    }
}
