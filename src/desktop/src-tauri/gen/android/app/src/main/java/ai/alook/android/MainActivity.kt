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
    @Volatile private var mainWebView: WebView? = null
    private var systemGestureInsets: Insets? = null
    @Volatile private var systemGestureRegionJson = "null"
    @Volatile private var geometryJson = "null"
    @Volatile private var keyboardJson = "null"
    private var geometryInsets: WindowInsetsCompat? = null
    private var keyboardAnimating = false
    private var keyboardInsets: WindowInsetsCompat? = null
    private val imeAnimations = mutableSetOf<WindowInsetsAnimationCompat>()
    private val gestureLayoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
        syncSystemGestureRegion()
        syncGeometry()
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
        WindowCompat.setDecorFitsSystemWindows(window, false)
        mobileShareImageDocumentOwner.attach(savedInstanceState)

        splashScreen.setKeepOnScreenCondition { !isReady }
        splashScreen.setOnExitAnimationListener { provider ->
            provider.remove()
        }

        val rootView: View = findViewById(android.R.id.content)

        val isDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        applyWindowTheme(isDark)

        var latestInsets: WindowInsetsCompat? = null
        fun publishInsets(insets: WindowInsetsCompat, holdKeyboard: Boolean = false, animating: Boolean = false) {
            geometryInsets = insets
            systemGestureInsets = insets.getInsets(WindowInsetsCompat.Type.systemGestures())
            if (!holdKeyboard) {
                keyboardInsets = insets
                keyboardAnimating = animating
            }
            syncGeometry()
            syncSystemGestureRegion()
        }
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, insets ->
            latestInsets = insets
            publishInsets(insets, holdKeyboard = imeAnimations.isNotEmpty())
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
                        publishInsets(insets, animating = true)
                    }
                    return insets
                }
                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    if (imeAnimations.remove(animation) && imeAnimations.isEmpty()) {
                        latestInsets?.let { publishInsets(it) }
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
        geometryJson = "null"
        keyboardJson = "null"
        geometryInsets = null
        keyboardInsets = null
        imeAnimations.clear()
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
        webView.addJavascriptInterface(ThemeBridge(this, webView), "AlookNative")

        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, THEME_OBSERVER_SCRIPT, setOf("*"))
        }
    }

    private fun syncGeometry() {
        val webView = mainWebView ?: return
        val insets = geometryInsets ?: ViewCompat.getRootWindowInsets(webView) ?: return
        val root = webView.rootView
        val location = IntArray(2)
        val rootLocation = IntArray(2)
        webView.getLocationInWindow(location)
        root.getLocationInWindow(rootLocation)
        val chrome = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val geometry = WebViewGeometry.fromWindow(
            root.width, root.height, location[0] - rootLocation[0], location[1] - rootLocation[1],
            webView.width, webView.height, chrome.left, chrome.top, chrome.right, chrome.bottom,
        ) ?: return
        val nextGeometry = geometry.toJson()
        if (geometryJson != nextGeometry) {
            geometryJson = nextGeometry
            webView.evaluateJavascript("window.dispatchEvent(new Event('alook:geometry-change'))", null)
        }
        val keyboard = keyboardInsets ?: if (imeAnimations.isEmpty()) insets else return
        val ime = keyboard.getInsets(WindowInsetsCompat.Type.ime())
        val bottom = if (keyboard.isVisible(WindowInsetsCompat.Type.ime())) {
            (location[1] - rootLocation[1] + webView.height - (root.height - ime.bottom)).coerceIn(0, webView.height)
        } else 0
        val nextKeyboard = "{\"bottomInset\":$bottom,\"viewportWidth\":${webView.width},\"isAnimating\":$keyboardAnimating}"
        if (keyboardJson != nextKeyboard) {
            keyboardJson = nextKeyboard
            webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('alook:keyboard-change',{detail:JSON.parse(window.AlookNative.getKeyboardSnapshot())}))", null)
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

    class ThemeBridge(private val activity: MainActivity, private val webView: WebView) {
        @JavascriptInterface
        fun getGeometrySnapshot(): String = if (activity.mainWebView === webView) activity.geometryJson else "null"

        @JavascriptInterface
        fun getKeyboardSnapshot(): String = if (activity.mainWebView === webView) activity.keyboardJson else "null"

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
