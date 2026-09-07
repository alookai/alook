package ai.alook.android

import android.webkit.WebView
import android.webkit.WebViewClient
import java.net.URI
import java.net.URLEncoder

internal object WebviewRecovery {
    private const val RECOVERY_ORIGIN = "alook-recovery.localhost"
    private const val RECOVERY_URL = "http://$RECOVERY_ORIGIN/network-error#target="

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

    fun recoveryUrl(target: String?): String? {
        if (!isHttpTarget(target)) return null
        return RECOVERY_URL + URLEncoder.encode(target, Charsets.UTF_8.name())
    }

    fun recoveryUrlForMainDocument(currentUrl: String?, failingUrl: String?): String? {
        if (documentIdentity(currentUrl) != documentIdentity(failingUrl)) return null
        return recoveryUrl(currentUrl)
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

    fun handleSslError(view: WebView, currentUrl: String?, failingUrl: String?): Boolean {
        return showRecovery(view, currentUrl, failingUrl)
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
