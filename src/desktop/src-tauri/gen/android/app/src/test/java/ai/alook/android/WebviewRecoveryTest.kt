package ai.alook.android

import android.webkit.WebViewClient
import java.net.URLDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class WebviewRecoveryTest {
    @Before
    fun resetState() {
        WebviewRecovery.resetCrashStateForTesting()
    }

    private fun extractTarget(recoveryUrl: String): String {
        val fragment = recoveryUrl.substringAfter('#')
        val targetParam = fragment.split('&').first { it.startsWith("target=") }
        return URLDecoder.decode(targetParam.substringAfter("target="), Charsets.UTF_8.name())
    }

    private fun extractAttempt(recoveryUrl: String): Long {
        val fragment = recoveryUrl.substringAfter('#')
        val attemptParam = fragment.split('&').first { it.startsWith("attempt=") }
        return attemptParam.substringAfter("attempt=").toLong()
    }

    @Test
    fun acceptsOnlyNetworkFailureCodes() {
        listOf(
            WebViewClient.ERROR_HOST_LOOKUP,
            WebViewClient.ERROR_CONNECT,
            WebViewClient.ERROR_IO,
            WebViewClient.ERROR_TIMEOUT,
            WebViewClient.ERROR_FAILED_SSL_HANDSHAKE,
        ).forEach { assertTrue(WebviewRecovery.isNetworkError(it)) }

        listOf(
            WebViewClient.ERROR_UNKNOWN,
            WebViewClient.ERROR_AUTHENTICATION,
            WebViewClient.ERROR_PROXY_AUTHENTICATION,
            WebViewClient.ERROR_REDIRECT_LOOP,
            WebViewClient.ERROR_UNSAFE_RESOURCE,
        ).forEach { assertFalse(WebviewRecovery.isNetworkError(it)) }
    }

    @Test
    fun recoveryFragmentRoundTripsExactTargetWithMonotonicAttempt() {
        val target = "https://alook.ai/c/channel?after=%23one&name=hello+world#message-7"
        val first = WebviewRecovery.recoveryUrl(target)!!
        val second = WebviewRecovery.recoveryUrl(target)!!
        assertEquals("http://alook-recovery.localhost/network-error", first.substringBefore('#'))
        assertEquals(target, extractTarget(first))
        assertEquals(target, extractTarget(second))
        assertNotEquals(first, second)
        assertTrue(extractAttempt(second) > extractAttempt(first))
    }

    @Test
    fun mainDocumentComparisonIgnoresFragmentAndKeepsExactCurrentUrl() {
        val current = "https://Alook.ai:443/c/room?after=%23one#message-7"
        val failing = "https://alook.ai/c/room?after=%23one"
        val recovery = WebviewRecovery.recoveryUrlForMainDocument(current, failing)!!
        assertEquals(current, extractTarget(recovery))
    }

    @Test
    fun differentMainDocumentsAreRejectedForLegacyErrors() {
        assertNull(
            WebviewRecovery.recoveryUrlForMainDocument(
                "https://alook.ai/c/one#message-7",
                "https://alook.ai/c/two",
            ),
        )
    }

    @Test
    fun sslFailureRecoversFromBootstrapDocumentWithoutStaleUrlMismatch() {
        val recovery = WebviewRecovery.recoveryUrlForSslFailure(
            "http://alook-recovery.localhost/bootstrap",
            "https://alook.ai/c",
        )!!
        assertEquals("https://alook.ai/c", extractTarget(recovery))
        assertNull(
            WebviewRecovery.recoveryUrlForSslFailure(
                "https://alook.ai/c/one",
                "https://alook.ai/c/two",
            ),
        )
    }

    @Test
    fun renderProcessRecoveryReloadsOnceThenEscalatesOnCrashLoop() {
        WebviewRecovery.recordAllowedUrl("https://alook.ai/c/room")
        val first = WebviewRecovery.recordRenderProcessCrash("https://alook.ai/c/room", nowMs = 1_000L)
        assertEquals(WebviewRecovery.CrashRecoveryAction.Reload("https://alook.ai/c/room"), first)
        assertEquals("https://alook.ai/c/room", WebviewRecovery.consumePendingCrashNavigationUrl())
        assertNull(WebviewRecovery.consumePendingCrashNavigationUrl())

        val second = WebviewRecovery.recordRenderProcessCrash("https://alook.ai/c/room", nowMs = 5_000L)
        assertTrue(second is WebviewRecovery.CrashRecoveryAction.Recovery)
        val expectedRecovery = (second as WebviewRecovery.CrashRecoveryAction.Recovery).recoveryUrl
        assertEquals("https://alook.ai/c/room", extractTarget(expectedRecovery))
        assertEquals(expectedRecovery, WebviewRecovery.consumePendingCrashNavigationUrl())
        assertNull(WebviewRecovery.consumePendingCrashNavigationUrl())

        val afterWindow = WebviewRecovery.recordRenderProcessCrash("https://alook.ai/c/room", nowMs = 40_000L)
        assertEquals(WebviewRecovery.CrashRecoveryAction.Reload("https://alook.ai/c/room"), afterWindow)
        assertEquals("https://alook.ai/c/room", WebviewRecovery.consumePendingCrashNavigationUrl())
        assertNull(WebviewRecovery.consumePendingCrashNavigationUrl())
    }

    @Test
    fun nonHttpAndRecoveryTargetsFailClosed() {
        listOf(
            null,
            "",
            "not a url",
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///tmp/page.html",
            "http://alook-recovery.localhost/network-error",
            "https://alook-recovery.localhost/network-error",
        ).forEach { assertNull(WebviewRecovery.recoveryUrl(it)) }
    }
}
