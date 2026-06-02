package com.alook.push

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.RemoteMessage

@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {

    private var pushToken: String? = null

    companion object {
        var instance: PushPlugin? = null
            private set
    }

    override fun load(webView: app.tauri.plugin.WebView) {
        super.load(webView)
        instance = this
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                pushToken = task.result
                val event = JSObject()
                event.put("token", pushToken)
                event.put("platform", "android")
                trigger("token", event)
            }
        }
    }

    fun onTokenRefresh(token: String) {
        pushToken = token
        val event = JSObject()
        event.put("token", token)
        event.put("platform", "android")
        trigger("token", event)
    }

    fun onMessageReceived(remoteMessage: RemoteMessage) {
        val event = JSObject()
        event.put("title", remoteMessage.notification?.title ?: "")
        event.put("body", remoteMessage.notification?.body ?: "")
        val data = JSObject()
        remoteMessage.data.forEach { (key, value) -> data.put(key, value) }
        event.put("data", data)
        trigger("notification", event)
    }

    @Command
    fun getToken(invoke: Invoke) {
        val result = JSObject()
        if (pushToken != null) {
            result.put("token", pushToken)
            result.put("platform", "android")
            invoke.resolve(result)
        } else {
            invoke.reject("Push token not yet available")
        }
    }

    @Command
    fun onNotification(invoke: Invoke) {
        invoke.resolve()
    }
}
