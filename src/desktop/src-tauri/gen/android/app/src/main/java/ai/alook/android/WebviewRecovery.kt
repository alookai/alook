package ai.alook.android

import android.webkit.WebView
import android.webkit.WebViewClient
import java.net.URI
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicLong

internal object WebviewRecovery {
    private const val RECOVERY_ORIGIN = "alook-recovery.localhost"
    private const val RECOVERY_URL = "http://$RECOVERY_ORIGIN/network-error#target="
    private const val PRODUCTION_TARGET = "https://alook.ai/c"
    private const val CRASH_LOOP_WINDOW_MS = 30_000L

    private val attemptCounter = AtomicLong(0L)

    @Volatile private var lastAllowedUrl: String? = null
    @Volatile private var lastCrashTimeMs: Long = 0L
    @Volatile private var consecutiveCrashes: Int = 0
    @Volatile private var pendingCrashNavigationUrl: String? = null

    sealed class CrashRecoveryAction {
        data class Reload(val targetUrl: String) : CrashRecoveryAction()
        data class Recovery(val recoveryUrl: String) : CrashRecoveryAction()
    }

    private data class DocumentIdentity(
        val scheme: String,
        val userInfo: String?,
        val host: String,
        val port: Int,
        val path: String,
        val query: String?,
    )

    fun isNetworkError(errorCode: Int): Boolean = when (errorCode) {
        WebViewClient.ERROR_HOST_LOOKUP,
        WebViewClient.ERROR_CONNECT,
        WebViewClient.ERROR_IO,
        WebViewClient.ERROR_TIMEOUT,
        WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> true
        else -> false
    }

    fun recordAllowedUrl(url: String?) {
        if (isHttpTarget(url)) {
            lastAllowedUrl = url
        }
    }

    fun recoveryUrl(target: String?): String? {
        if (!isHttpTarget(target)) return null
        val attempt = attemptCounter.incrementAndGet()
        return RECOVERY_URL + URLEncoder.encode(target, Charsets.UTF_8.name()) + "&attempt=$attempt"
    }

    fun recoveryUrlForMainDocument(currentUrl: String?, failingUrl: String?): String? {
        if (documentIdentity(currentUrl) != documentIdentity(failingUrl)) return null
        return recoveryUrl(currentUrl)
    }

    fun recoveryUrlForSslFailure(currentUrl: String?, failingUrl: String?): String? {
        return recoveryUrlForMainDocument(currentUrl, failingUrl)
            ?: if (isRecoveryOrBlankDocument(currentUrl)) recoveryUrl(failingUrl) else null
    }

    fun handleError(
        view: WebView,
        errorCode: Int,
        currentUrl: String?,
        failingUrl: String?,
    ): Boolean {
        if (!isNetworkError(errorCode)) return false
        return showRecovery(view, currentUrl, failingUrl)
    }

    fun handleMainFrameError(
        view: WebView,
        errorCode: Int,
        failingUrl: String?,
    ): Boolean {
        if (!isNetworkError(errorCode)) return false
        val recovery = recoveryUrl(failingUrl) ?: return false
        view.stopLoading()
        view.loadUrl(recovery)
        return true
    }

    fun handleSslError(view: WebView, currentUrl: String?, failingUrl: String?): Boolean {
        val recovery = recoveryUrlForSslFailure(currentUrl, failingUrl) ?: return false
        view.stopLoading()
        view.loadUrl(recovery)
        return true
    }

    @Synchronized
    fun decideRenderProcessRecovery(
        currentUrl: String?,
        nowMs: Long = System.currentTimeMillis(),
    ): CrashRecoveryAction {
        val target = when {
            isHttpTarget(currentUrl) -> currentUrl!!
            isHttpTarget(lastAllowedUrl) -> lastAllowedUrl!!
            else -> PRODUCTION_TARGET
        }
        val withinWindow = lastCrashTimeMs > 0L && (nowMs - lastCrashTimeMs) in 0L..CRASH_LOOP_WINDOW_MS
        consecutiveCrashes = if (withinWindow) consecutiveCrashes + 1 else 1
        lastCrashTimeMs = nowMs
        return if (consecutiveCrashes <= 1) {
            CrashRecoveryAction.Reload(target)
        } else {
            val recovery = recoveryUrl(target)
                ?: "http://$RECOVERY_ORIGIN/network-error#reason=initialization"
            CrashRecoveryAction.Recovery(recovery)
        }
    }

    @Synchronized
    fun recordRenderProcessCrash(
        currentUrl: String?,
        nowMs: Long = System.currentTimeMillis(),
    ): CrashRecoveryAction {
        val action = decideRenderProcessRecovery(currentUrl, nowMs)
        pendingCrashNavigationUrl = when (action) {
            is CrashRecoveryAction.Reload -> action.targetUrl
            is CrashRecoveryAction.Recovery -> action.recoveryUrl
        }
        return action
    }

    @Synchronized
    fun resetCrashStateForTesting() {
        lastAllowedUrl = null
        lastCrashTimeMs = 0L
        consecutiveCrashes = 0
        pendingCrashNavigationUrl = null
    }

    @Synchronized
    fun consumePendingCrashNavigationUrl(): String? {
        val next = pendingCrashNavigationUrl
        pendingCrashNavigationUrl = null
        return next
    }

    fun handleRenderProcessGone(
        view: WebView,
        currentUrl: String?,
        @Suppress("UNUSED_PARAMETER") didCrash: Boolean,
    ): Boolean {
        recordRenderProcessCrash(currentUrl)
        val activity = view.context as? MainActivity
        if (activity != null) {
            activity.handleWebViewRenderProcessGone(view)
        }
        return true
    }

    private fun isRecoveryOrBlankDocument(url: String?): Boolean {
        if (url.isNullOrEmpty() || url == "about:blank") return true
        return runCatching {
            val parsed = URI(url)
            parsed.host.equals(RECOVERY_ORIGIN, ignoreCase = true)
        }.getOrDefault(false)
    }

    private fun isHttpTarget(target: String?): Boolean {
        if (target.isNullOrEmpty()) return false
        return runCatching {
            val parsed = URI(target)
            val scheme = parsed.scheme?.lowercase()
            (scheme == "http" || scheme == "https") &&
                !parsed.host.isNullOrEmpty() &&
                !parsed.host.equals(RECOVERY_ORIGIN, ignoreCase = true)
        }.getOrDefault(false)
    }

    private fun documentIdentity(target: String?): DocumentIdentity? {
        if (!isHttpTarget(target)) return null
        return runCatching {
            val parsed = URI(target).normalize()
            val scheme = parsed.scheme.lowercase()
            DocumentIdentity(
                scheme = scheme,
                userInfo = parsed.rawUserInfo,
                host = parsed.host.lowercase(),
                port = if (parsed.port >= 0) parsed.port else if (scheme == "https") 443 else 80,
                path = parsed.rawPath.orEmpty().ifEmpty { "/" },
                query = parsed.rawQuery,
            )
        }.getOrNull()
    }

    private fun showRecovery(
        view: WebView,
        currentUrl: String?,
        failingUrl: String?,
    ): Boolean {
        val recovery = recoveryUrlForMainDocument(currentUrl, failingUrl) ?: return false
        view.stopLoading()
        view.loadUrl(recovery)
        return true
    }
}
