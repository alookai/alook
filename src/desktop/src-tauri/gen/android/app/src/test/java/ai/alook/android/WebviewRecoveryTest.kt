package ai.alook.android

import android.webkit.WebViewClient
import java.net.URLDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WebviewRecoveryTest {
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
    fun recoveryFragmentRoundTripsTheExactTarget() {
        val target = "https://alook.ai/c/channel?after=%23one&name=hello+world#message-7"
        val recovery = WebviewRecovery.recoveryUrl(target)!!
        assertEquals("http://alook-recovery.localhost/network-error", recovery.substringBefore('#'))
        assertEquals(
            target,
            URLDecoder.decode(recovery.substringAfter("#target="), Charsets.UTF_8.name()),
        )
    }

    @Test
    fun mainDocumentComparisonIgnoresFragmentAndKeepsExactCurrentUrl() {
        val current = "https://Alook.ai:443/c/room?after=%23one#message-7"
        val failing = "https://alook.ai/c/room?after=%23one"
        val recovery = WebviewRecovery.recoveryUrlForMainDocument(current, failing)!!
        assertEquals(
            current,
            URLDecoder.decode(recovery.substringAfter("#target="), Charsets.UTF_8.name()),
        )
    }

    @Test
    fun differentMainDocumentsAreRejected() {
        assertNull(
            WebviewRecovery.recoveryUrlForMainDocument(
                "https://alook.ai/c/one#message-7",
                "https://alook.ai/c/two",
            ),
        )
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
