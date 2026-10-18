package ai.alook.android

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.net.Uri
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject
import androidx.core.graphics.Insets
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import ai.alook.plugin.mobileshareimage.MobileShareImageDocumentOwner

class MainActivity : TauriActivity() {
    override val handleBackNavigation: Boolean = false

    private val nativeBackGesture = NativeBackGesture()
    private val gestureCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackStarted(backEvent: BackEventCompat) {
            val href = mainWebView?.url ?: return
            if (!trustedBackOrigin(Uri.parse(href))) { nativeBackGesture.invalidate(); return }
            nativeBackGesture.start(JSONObject.quote(href), JSONObject.quote(backDocumentId.orEmpty()))
        }
        override fun handleOnBackCancelled() {
            nativeBackGesture.cancel()
        }
        override fun handleOnBackPressed() {
            val href = mainWebView?.url.orEmpty()
            val payload = nativeBackGesture.complete(JSONObject.quote(href), JSONObject.quote(backDocumentId.orEmpty())) ?: return
            val reply = backReplyProxy
            if (reply != null && trustedBackOrigin(Uri.parse(href))) {
                reply.postMessage(payload)
                return
            }
            isEnabled = false
            try {
                onBackPressedDispatcher.onBackPressed()
            } finally {
                isEnabled = true
            }
        }
    }

    private var backReplyProxy: JavaScriptReplyProxy? = null
    private var backDocumentId: String? = null
    private val backLayoutListener = View.OnLayoutChangeListener { view, _, _, _, _, _, _, _, _ ->
        if (view === mainWebView) publishBackInsets()
    }

    private var isReady = false
    private var mainWebView: WebView? = null
    private var startupAttachListener: View.OnAttachStateChangeListener? = null
    private val mobileShareImageDocumentOwner = MobileShareImageDocumentOwner(this)

    companion object {
        const val COLOR_LIGHT = "#FFFFFF"
        const val COLOR_DARK = "#100D0A"

        const val THEME_OBSERVER_SCRIPT = """
            (function() {
                if (window.__alookThemeObserverInstalled) return;
                window.__alookThemeObserverInstalled = true;
                function sync() {
                    var root = document.documentElement;
                    var dark = root.classList.contains('dark');
                    if (!dark && !root.classList.contains('light')) return;
                    if (window.AlookNative) window.AlookNative.setWindowTheme(dark);
                }
                sync();
                new MutationObserver(sync).observe(document.documentElement, {
                    attributes: true, attributeFilter: ['class']
                });
            })();
        """
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splashScreen = installSplashScreen()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        mobileShareImageDocumentOwner.attach(savedInstanceState)

        splashScreen.setKeepOnScreenCondition { !isReady }
        splashScreen.setOnExitAnimationListener { provider ->
            provider.remove()
        }

        val rootView: View = findViewById(android.R.id.content)

        val isDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        applyWindowTheme(isDark)

        ViewCompat.setOnApplyWindowInsetsListener(rootView) { v, insets ->
            val chromeTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            val chromeInsets = insets.getInsets(chromeTypes)
            val imeType = WindowInsetsCompat.Type.ime()
            val imeInsets = insets.getInsets(imeType)
            val imeVisible = insets.isVisible(imeType)
            val bottomPadding = if (imeVisible) imeInsets.bottom else chromeInsets.bottom
            v.setPadding(chromeInsets.left, chromeInsets.top, chromeInsets.right, bottomPadding)
            publishBackInsets()
            WindowInsetsCompat.Builder(insets)
                .setInsets(chromeTypes, Insets.NONE)
                .setInsets(imeType, Insets.of(imeInsets.left, imeInsets.top, imeInsets.right, 0))
                .build()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        mobileShareImageDocumentOwner.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onResume() {
        super.onResume()
        attachBackGesture()
    }

    override fun onStop() {
        nativeBackGesture.invalidate()
        super.onStop()
    }

    fun onBackDocumentStarted(webView: WebView) {
        if (webView === mainWebView) {
            nativeBackGesture.invalidate()
            backReplyProxy = null
            backDocumentId = null
        }
    }

    private fun attachBackGesture() {
        if (mainWebView == null || isDestroyed || isFinishing) return
        gestureCallback.remove()
        onBackPressedDispatcher.addCallback(this, gestureCallback)
    }

    private fun trustedBackOrigin(url: Uri): Boolean =
        url.scheme == "https" && url.host == "alook.ai" && (url.port == -1 || url.port == 443)
            || BuildConfig.DEBUG && url.scheme == "http" && url.host == "localhost" && url.port == 3000

    private fun publishBackInsets() {
        val webView = mainWebView ?: return
        val reply = backReplyProxy ?: return
        val document = backDocumentId ?: return
        val href = webView.url ?: return
        if (!trustedBackOrigin(Uri.parse(href)) || webView.width <= 0) return
        val insets = ViewCompat.getRootWindowInsets(webView)
            ?.getInsets(WindowInsetsCompat.Type.systemGestures()) ?: return
        val location = IntArray(2)
        webView.getLocationInWindow(location)
        val left = (insets.left - location[0]).coerceIn(0, webView.width)
        val right = (insets.right - (window.decorView.width - location[0] - webView.width))
            .coerceIn(0, webView.width)
        nativeBackGesture.insets(JSONObject.quote(href), JSONObject.quote(document), left, right, webView.width)
            ?.let { reply.postMessage(it) }
    }

    private fun installBackMessages(webView: WebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        val origins = mutableSetOf("https://alook.ai")
        if (BuildConfig.DEBUG) origins.add("http://localhost:3000")
        WebViewCompat.addWebMessageListener(webView, "AlookBack", origins) { view, message, origin, mainFrame, reply ->
            if (view !== mainWebView || !mainFrame || !trustedBackOrigin(origin)) return@addWebMessageListener
            val text = try { message.data } catch (_: IllegalStateException) { return@addWebMessageListener }
                ?: return@addWebMessageListener
            if (text.length > 512) return@addWebMessageListener
            val data = try { JSONObject(text) } catch (_: Exception) { return@addWebMessageListener }
            val token = data.optString("document")
            if (token.isEmpty() || token.length > 128) return@addWebMessageListener
            when (data.optString("type")) {
                "subscribe" -> {
                    if (backDocumentId != token) {
                        nativeBackGesture.invalidate()
                    }
                    backReplyProxy = reply
                    backDocumentId = token
                    publishBackInsets()
                }
                "unsubscribe" -> if (backDocumentId == token) {
                    nativeBackGesture.invalidate()
                    backReplyProxy = null
                    backDocumentId = null
                }
            }
        }
    }

    override fun onDestroy() {
        nativeBackGesture.reset()
        backReplyProxy = null
        backDocumentId = null
        gestureCallback.remove()
        clearStartupAttachListener()
        mainWebView?.removeOnLayoutChangeListener(backLayoutListener)
        mainWebView = null
        mobileShareImageDocumentOwner.detach()
        super.onDestroy()
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        clearStartupAttachListener()
        mainWebView?.removeOnLayoutChangeListener(backLayoutListener)
        mainWebView = webView
        webView.addOnLayoutChangeListener(backLayoutListener)
        backReplyProxy = null
        backDocumentId = null
        nativeBackGesture.reset()
        installBackMessages(webView)
        webView.post { if (mainWebView === webView) attachBackGesture() }
        if (!isReady && !isDestroyed && !isFinishing) {
            val listener = object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(view: View) {
                    if (view !== mainWebView || isDestroyed || isFinishing) return
                    isReady = true
                    clearStartupAttachListener()
                }
                override fun onViewDetachedFromWindow(view: View) {}
            }
            startupAttachListener = listener
            webView.addOnAttachStateChangeListener(listener)
            if (webView.isAttachedToWindow) listener.onViewAttachedToWindow(webView)
        }
        webView.addJavascriptInterface(ThemeBridge(this), "AlookNative")

        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, THEME_OBSERVER_SCRIPT, setOf("*"))
        }
    }

    private fun clearStartupAttachListener() {
        startupAttachListener?.let { mainWebView?.removeOnAttachStateChangeListener(it) }
        startupAttachListener = null
    }

    private fun applyWindowTheme(dark: Boolean) {
        val color = if (dark) Color.parseColor(COLOR_DARK) else Color.parseColor(COLOR_LIGHT)
        runOnUiThread {
            val rootView: View = findViewById(android.R.id.content)
            rootView.setBackgroundColor(color)
            window.statusBarColor = color
            window.navigationBarColor = color
            WindowCompat.getInsetsController(window, rootView).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }

    class ThemeBridge(private val activity: MainActivity) {
        @JavascriptInterface
        fun setWindowTheme(dark: Boolean) {
            activity.applyWindowTheme(dark)
        }
    }
}
