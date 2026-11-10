package ai.alook.android

import android.content.res.Configuration
import android.graphics.Rect
import android.os.Build
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.Gravity
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageView
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
    private var startupFrameReady = false
    private var startupBackdrop: ImageView? = null
    @Volatile private var mainWebView: WebView? = null
    private var systemGestureInsets: Insets? = null
    @Volatile private var systemGestureRegionJson = "null"
    @Volatile private var geometryJson = "null"
    private var geometryInsets: WindowInsetsCompat? = null
    private var availableInsets: WindowInsetsCompat? = null
    private var insetsHost: View? = null
    private val hostLayoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
        resizeWebView()
        syncGeometry()
    }
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
                    if (!document.body || !document.body.style) return null;
                    var published = document.body.style.getPropertyValue('--app-edge-fade-color').trim();
                    if (!published) return null;
                    var canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    var context = canvas.getContext('2d');
                    if (!context) return null;
                    context.fillStyle = 'transparent';
                    context.fillStyle = published;
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
        StartupLog.nativeLibraryReady()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        mobileShareImageDocumentOwner.attach(savedInstanceState)

        splashScreen.setKeepOnScreenCondition { !isReady }
        splashScreen.setOnExitAnimationListener { provider ->
            StartupLog.handoffBegin()
            provider.remove()
            StartupLog.handoffReturned()
        }

        val rootView: View = findViewById(android.R.id.content)

        val isDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        applyWindowTheme(isDark)

        var latestInsets: WindowInsetsCompat? = null
        insetsHost = rootView
        rootView.addOnLayoutChangeListener(hostLayoutListener)
        fun publishInsets(insets: WindowInsetsCompat, holdKeyboard: Boolean = false) {
            geometryInsets = insets
            systemGestureInsets = insets.getInsets(WindowInsetsCompat.Type.systemGestures())
            if (!holdKeyboard) {
                availableInsets = insets
            }
            resizeWebView()
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
                        publishInsets(insets)
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

    override fun onResume() {
        super.onResume()
        StartupLog.foregroundChanged(true)
    }

    override fun onPause() {
        StartupLog.foregroundChanged(false)
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        mobileShareImageDocumentOwner.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        clearStartupAttachListener()
        mainWebView?.removeOnLayoutChangeListener(gestureLayoutListener)
        mainWebView = null
        clearStartupBackdrop()
        systemGestureRegionJson = "null"
        geometryJson = "null"
        geometryInsets = null
        availableInsets = null
        insetsHost?.let {
            it.removeOnLayoutChangeListener(hostLayoutListener)
            ViewCompat.setOnApplyWindowInsetsListener(it, null)
            ViewCompat.setWindowInsetsAnimationCallback(it, null)
        }
        insetsHost = null
        imeAnimations.clear()
        mobileShareImageDocumentOwner.detach()
        super.onDestroy()
    }

    override fun onWebViewCreate(webView: WebView) {
        StartupLog.webViewCreated()
        super.onWebViewCreate(webView)
        clearStartupAttachListener()
        clearStartupBackdrop()
        mainWebView?.removeOnLayoutChangeListener(gestureLayoutListener)
        mainWebView = webView
        webView.setBackgroundColor(Color.TRANSPARENT)
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
        resizeWebView()

        syncSystemGestureRegion()
        if (!isReady && !isDestroyed && !isFinishing) {
            val listener = object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(view: View) {
                    if (view !== mainWebView || isDestroyed || isFinishing) return
                    webView.post { installStartupBackdrop(webView) }
                    isReady = startupFrameReady
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

    @androidx.annotation.Keep
    fun alookStartupInitializationFailed() {
        if (isDestroyed || isFinishing) return
        isReady = true
        clearStartupAttachListener()
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Alook")
            .setMessage("Alook could not start. Close and reopen the app.")
            .setCancelable(false)
            .setPositiveButton("Close Alook") { _, _ -> finishAndRemoveTask() }
            .show()
    }

    private fun installStartupBackdrop(webView: WebView) {
        if (startupFrameReady || webView !== mainWebView || !webView.isAttachedToWindow || isDestroyed || isFinishing) return
        val host = webView.parent as? FrameLayout ?: return
        val backdrop = startupBackdrop ?: ImageView(this).apply {
            setImageResource(R.drawable.splash_icon)
            scaleType = ImageView.ScaleType.FIT_CENTER
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            isClickable = false
            isFocusable = false
        }.also { startupBackdrop = it }
        (backdrop.parent as? ViewGroup)?.removeView(backdrop)
        val size = (288 * resources.displayMetrics.density).toInt()
        host.addView(backdrop, host.indexOfChild(webView), FrameLayout.LayoutParams(size, size, Gravity.CENTER))
    }

    private fun clearStartupBackdrop() {
        val backdrop = startupBackdrop ?: return
        startupBackdrop = null
        (backdrop.parent as? ViewGroup)?.removeView(backdrop)
    }

    @androidx.annotation.Keep
    fun alookStartupDocument(): Int {
        val webView = mainWebView ?: return 0
        if (isDestroyed || isFinishing) return 0
        val uri = webView.url?.let { android.net.Uri.parse(it) } ?: return 0
        if (uri.scheme != "http" || uri.host != "alook-recovery.localhost" ||
            (uri.port != -1 && uri.port != 80) || uri.userInfo != null || uri.query != null) return 0
        return when (uri.path) { "/bootstrap" -> 1; "/network-error" -> 2; else -> 0 }
    }

    @androidx.annotation.Keep
    fun alookBootstrapFrameReady(): Boolean {
        val webView = mainWebView ?: return false
        if (alookStartupDocument() == 0) return false
        startupFrameReady = true
        clearStartupBackdrop()
        isReady = webView.isAttachedToWindow
        return true
    }

    private fun nativeWindowBounds(): Rect {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return windowManager.currentWindowMetrics.bounds
        return Rect(0, 0, window.decorView.width, window.decorView.height)
    }

    private fun resizeWebView() {
        val webView = mainWebView ?: return
        val parent = webView.parent as? ViewGroup ?: return
        val insets = availableInsets ?: ViewCompat.getRootWindowInsets(webView) ?: return
        val location = IntArray(2)
        parent.getLocationInWindow(location)
        val height = WebViewAvailableHeight.fromWindow(
            nativeWindowBounds().height(), parent.height - parent.paddingBottom,
            location[1] + webView.top, webView.top,
            insets.getInsets(WindowInsetsCompat.Type.ime()).bottom,
        ) ?: return
        val params = webView.layoutParams
        if (params.height != height) {
            params.height = height
            webView.layoutParams = params
        }
        if (webView.height != height) webView.layout(webView.left, webView.top, webView.right, webView.top + height)
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
        val windowBounds = nativeWindowBounds()
        val viewTop = location[1] - rootLocation[1]
        val geometry = WebViewGeometry.fromWindow(
            windowBounds.width(), windowBounds.height(), location[0] - rootLocation[0], viewTop,
            webView.width, webView.height, chrome.left, chrome.top, chrome.right, chrome.bottom,
        ) ?: return
        val nextGeometry = geometry.toJson(windowBounds.height(), chrome.bottom, viewTop)
        if (geometryJson != nextGeometry) {
            geometryJson = nextGeometry
            webView.evaluateJavascript("window.dispatchEvent(new Event('alook:geometry-change'))", null)
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
        fun getKeyboardSnapshot(): String = if (activity.mainWebView === webView) "{\"resizesViewport\":true}" else "null"

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
