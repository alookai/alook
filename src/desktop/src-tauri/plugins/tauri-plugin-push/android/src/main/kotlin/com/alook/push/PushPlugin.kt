package com.alook.push

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import com.google.firebase.messaging.FirebaseMessaging

@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {

    private var pushToken: String? = null

    override fun load(webView: app.tauri.plugin.WebView) {
        super.load(webView)
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
