package ai.alook.android

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import ai.alook.plugin.mobileshareimage.MobileShareImageDocumentOwner

class MainActivity : TauriActivity() {
    override val handleBackNavigation: Boolean = false

    private var isReady = false
    private var mainWebView: WebView? = null
    private var systemGestureInsets: Insets? = null
    @Volatile private var systemGestureRegionJson = "null"
    @Volatile private var safeAreaTop = -1.0
    private val gestureLayoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
        syncSystemGestureRegion()
    }
    private var startupAttachListener: View.OnAttachStateChangeListener? = null
    private val mobileShareImageDocumentOwner = MobileShareImageDocumentOwner(this)

    companion object {
        const val COLOR_LIGHT = "#FAF6EE"
        const val COLOR_DARK = "#000000"

        const val THEME_OBSERVER_SCRIPT = """
            (function() {
                if (window.__alookThemeObserverInstalled) return;
                window.__alookThemeObserverInstalled = true;
                function background() {
                    if (!document.body) return null;
                    var canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    var context = canvas.getContext('2d');
                    if (!context) return null;
                    var meta = document.querySelector('meta[name=theme-color]');
                    context.fillStyle = meta && meta.content ? meta.content : getComputedStyle(document.body).backgroundColor;
                    context.fillRect(0, 0, 1, 1);
                    var pixels = context.getImageData(0, 0, 1, 1).data;
                    if (pixels[3] !== 255) return null;
                    return '#' + Array.from(pixels).slice(0, 3).map(function(value) {
                        return value.toString(16).padStart(2, '0');
                    }).join('');
                }
                function sync() {
                    var root = document.documentElement;
                    var dark = root.classList.contains('dark');
                    if (!dark && !root.classList.contains('light')) return;
                    var color = background();
                    if (window.AlookNative) {
                        if (color && window.AlookNative.setWindowBackground) window.AlookNative.setWindowBackground(dark, color);
                        else window.AlookNative.setWindowTheme(dark);
                    }
                }
                document.addEventListener('DOMContentLoaded', sync);
                window.addEventListener('load', sync);
                window.addEventListener('alook:theme-color-change', sync);
                sync();
                new MutationObserver(sync).observe(document.documentElement, {
                    attributes: true, attributeFilter: ['class', 'data-tn-mode']
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

        val imeAnimations = mutableSetOf<WindowInsetsAnimationCompat>()
        var latestInsets: WindowInsetsCompat? = null
        fun applyPadding(insets: WindowInsetsCompat, holdBottom: Boolean = false) {
            val chromeTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            val chrome = insets.getInsets(chromeTypes)
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val bottom = if (holdBottom) rootView.paddingBottom else maxOf(chrome.bottom, ime.bottom)
            rootView.setPadding(chrome.left, chrome.top, chrome.right, bottom)
            systemGestureInsets = insets.getInsets(WindowInsetsCompat.Type.systemGestures())
            val nextTop = chrome.top.toDouble() / resources.displayMetrics.density
            if (safeAreaTop != nextTop) {
                safeAreaTop = nextTop
                mainWebView?.evaluateJavascript("window.dispatchEvent(new Event('alook:safe-area-change'))", null)
            }
            syncSystemGestureRegion()
        }
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, insets ->
            latestInsets = insets
            // The layout pass receives the end state before the IME starts moving.
            applyPadding(insets, holdBottom = imeAnimations.isNotEmpty())
            insets
        }
        ViewCompat.setWindowInsetsAnimationCallback(rootView,
            object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_STOP) {
                override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) imeAnimations.add(animation)
                }
                override fun onProgress(
                    insets: WindowInsetsCompat,
                    runningAnimations: MutableList<WindowInsetsAnimationCompat>,
                ): WindowInsetsCompat {
                    if (runningAnimations.any { it.typeMask and WindowInsetsCompat.Type.ime() != 0 }) {
                        applyPadding(insets)
                    }
                    return insets
                }
                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    if (imeAnimations.remove(animation) && imeAnimations.isEmpty()) {
                        latestInsets?.let { applyPadding(it) }
                    }
                }
            })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        mobileShareImageDocumentOwner.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        clearStartupAttachListener()
        mainWebView?.removeOnLayoutChangeListener(gestureLayoutListener)
        mainWebView = null
        systemGestureRegionJson = "null"
        mobileShareImageDocumentOwner.detach()
        super.onDestroy()
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        clearStartupAttachListener()
        mainWebView?.removeOnLayoutChangeListener(gestureLayoutListener)
        mainWebView = webView
        webView.addOnLayoutChangeListener(gestureLayoutListener)
        // Consume only at the WebView leaf, after the root animation callback sees the original insets.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
            val chromeTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            val imeType = WindowInsetsCompat.Type.ime()
            val ime = insets.getInsets(imeType)
            WindowInsetsCompat.Builder(insets)
                .setInsets(chromeTypes, Insets.NONE)
                .setInsets(imeType, Insets.of(ime.left, ime.top, ime.right, 0))
                .build()
        }
        ViewCompat.requestApplyInsets(webView)

        syncSystemGestureRegion()
        if (!isReady && !isDestroyed && !isFinishing) {
            val listener = object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(view: View) {
                    if (view !== mainWebView || isDestroyed || isFinishing) return
                    isReady = true
                    syncSystemGestureRegion()
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

    private fun syncSystemGestureRegion() {
        val webView = mainWebView ?: return
        val insets = systemGestureInsets ?: ViewCompat.getRootWindowInsets(webView)
            ?.getInsets(WindowInsetsCompat.Type.systemGestures()) ?: return
        val root = webView.rootView
        val location = IntArray(2)
        val rootLocation = IntArray(2)
        webView.getLocationInWindow(location)
        root.getLocationInWindow(rootLocation)
        systemGestureRegionJson = SystemGestureRegion.fromWindow(
            root.width, location[0] - rootLocation[0], webView.width, insets.left, insets.right,
        )?.toJson() ?: "null"
    }

    private fun clearStartupAttachListener() {
        startupAttachListener?.let { mainWebView?.removeOnAttachStateChangeListener(it) }
        startupAttachListener = null
    }

    private fun applyWindowTheme(dark: Boolean, background: Int? = null) {
        val color = background ?: if (dark) Color.parseColor(COLOR_DARK) else Color.parseColor(COLOR_LIGHT)
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
        fun getSafeAreaTop(): Double = activity.safeAreaTop

        @JavascriptInterface
        fun getSystemGestureRegion(): String = activity.systemGestureRegionJson

        @JavascriptInterface
        fun setWindowBackground(dark: Boolean, color: String) {
            if (!color.matches(Regex("^#[0-9a-fA-F]{6}$"))) return
            activity.applyWindowTheme(dark, Color.parseColor(color))
        }

        @JavascriptInterface
        fun setWindowTheme(dark: Boolean) {
            activity.applyWindowTheme(dark)
        }
    }
}
