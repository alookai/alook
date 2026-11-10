package ai.alook.android

import android.app.Application
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewOutcomeReceiver
import androidx.webkit.WebViewStartUpConfig
import androidx.webkit.WebViewStartUpResult
import androidx.webkit.WebViewStartupException
import java.util.concurrent.Executors

class AlookApplication : Application() {
    override fun onCreate() {
        StartupLog.applicationEntry()
        super.onCreate()
        val executor = Executors.newSingleThreadExecutor { task ->
            Thread(task, "alook-webview-startup").apply { isDaemon = true }
        }
        StartupLog.asyncRequested()
        try {
            WebViewCompat.startUpWebView(
                this,
                WebViewStartUpConfig.Builder(executor).build(),
                object : WebViewOutcomeReceiver<WebViewStartUpResult, WebViewStartupException> {
                    override fun onResult(result: WebViewStartUpResult) {
                        executor.shutdown()
                        StartupLog.asyncCompleted(true, result.uiThreadBlockingStartUpLocations?.size ?: -1)
                    }

                    override fun onError(error: WebViewStartupException) {
                        executor.shutdown()
                        StartupLog.asyncCompleted(false)
                    }
                },
            )
        } catch (_: RuntimeException) {
            executor.shutdown()
            StartupLog.asyncCompleted(false)
        }
    }
}
