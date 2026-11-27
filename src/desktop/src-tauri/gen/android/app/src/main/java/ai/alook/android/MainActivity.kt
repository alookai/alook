package ai.alook.android

import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Build
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.Gravity
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
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import ai.alook.plugin.mobileshareimage.MobileShareImageDocumentOwner

class MainActivity : TauriActivity() {
    override val handleBackNavigation: Boolean = false

    private var isReady = false
    private var startupFrameReady = false
    private var pendingCrashNavigationUrl: String? = null
    private var startupBackdrop: ImageView? = null
    @Volatile private var mainWebView: WebView? = null
    @Volatile private var activeReplyProxy: JavaScriptReplyProxy? = null
    private var systemGestureInsets: Insets? = null
    @Volatile private var systemGestureRegionJson = "null"
    @Volatile private var geometryJson = "null"
    @Volatile private var keyboardJson = AndroidNativeBridge.settledOverlayKeyboardJson(0, 0, 0L)
    private val imeAnimationTracker = AndroidNativeBridge.ImeAnimationTracker<WindowInsetsAnimationCompat>()
    private var lastAppliedImeInset = 0
    private var lastSentKeyboardInset = 0
    private var lastSentKeyboardViewportWidth = 0
    private var lastSentKeyboardSettled = true
    private var keyboardSequence = 0L
    private var geometryInsets: WindowInsetsCompat? = null
    private var availableInsets: WindowInsetsCompat? = null
    private var insetsHost: View? = null
    private val hostLayoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
        resizeWebView()
        syncGeometry()
    }
    private val gestureLayoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
        syncSystemGestureRegion()
        syncGeometry()
    }
    private var startupAttachListener: View.OnAttachStateChangeListener? = null
    private val mobileShareImageDocumentOwner = MobileShareImageDocumentOwner(this)

    companion object {
        const val COLOR_LIGHT = "#FAF6EE"
        const val COLOR_DARK = "#000000"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splashScreen = installSplashScreen()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        StartupLog.nativeLibraryReady()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        mobileShareImageDocumentOwner.attach(savedInstanceState)

        pendingCrashNavigationUrl = WebviewRecovery.consumePendingCrashNavigationUrl()
        if (pendingCrashNavigationUrl != null) {
            startupFrameReady = true
            isReady = true
        }

        splashScreen.setKeepOnScreenCondition { !isReady }
        splashScreen.setOnExitAnimationListener { provider ->
            StartupLog.handoffBegin()
            provider.remove()
            StartupLog.handoffReturned()
        }

        val rootView: View = findViewById(android.R.id.content)

        val isDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        applyWindowTheme(isDark)

        insetsHost = rootView
        rootView.addOnLayoutChangeListener(hostLayoutListener)
        ViewCompat.setWindowInsetsAnimationCallback(
            rootView,
            object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                    if ((animation.typeMask and WindowInsetsCompat.Type.ime()) == 0) return
                    imeAnimationTracker.onPrepare(animation, lastAppliedImeInset)
                }

                override fun onStart(
                    animation: WindowInsetsAnimationCompat,
                    bounds: WindowInsetsAnimationCompat.BoundsCompat,
                ): WindowInsetsAnimationCompat.BoundsCompat {
                    if ((animation.typeMask and WindowInsetsCompat.Type.ime()) != 0) {
                        val targetInset = imeAnimationTracker.onStart(
                            animation,
                            lastAppliedImeInset,
                            bounds.upperBound.bottom,
                        )
                        val durationMs = animation.durationMillis.coerceIn(0L, 1000L)
                        emitKeyboardState(targetInset, durationMs, if (durationMs > 0L) "animating" else "settled")
                    }
                    return bounds
                }

                override fun onProgress(
                    insets: WindowInsetsCompat,
                    runningAnimations: MutableList<WindowInsetsAnimationCompat>,
                ): WindowInsetsCompat = insets

                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    if ((animation.typeMask and WindowInsetsCompat.Type.ime()) == 0) return
                    if (!imeAnimationTracker.onEnd(animation)) return
                    val finalIme = (availableInsets ?: ViewCompat.getRootWindowInsets(rootView))
                        ?.getInsets(WindowInsetsCompat.Type.ime())
                        ?.bottom
                        ?: lastAppliedImeInset
                    lastAppliedImeInset = finalIme
                    emitKeyboardState(finalIme, 0L, "settled")
                }
            },
        )
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, insets ->
            geometryInsets = insets
            systemGestureInsets = insets.getInsets(WindowInsetsCompat.Type.systemGestures())
            availableInsets = insets
            val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val imeChanged = imeBottom != lastAppliedImeInset
            lastAppliedImeInset = imeBottom
            resizeWebView()
            syncGeometry()
            syncSystemGestureRegion()
            if (!imeAnimationTracker.isActive && imeChanged) {
                emitKeyboardState(imeBottom, 0L, "settled")
            }
            insets
        }
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
        pendingCrashNavigationUrl = null
        activeReplyProxy = null
        mainWebView?.removeOnLayoutChangeListener(gestureLayoutListener)
        mainWebView = null
        clearStartupBackdrop()
        systemGestureRegionJson = "null"
        geometryJson = "null"
        keyboardJson = AndroidNativeBridge.settledOverlayKeyboardJson(0, 0, 0L)
        imeAnimationTracker.clear()
        lastAppliedImeInset = 0
        lastSentKeyboardInset = 0
        lastSentKeyboardViewportWidth = 0
        lastSentKeyboardSettled = true
        keyboardSequence = 0L
        geometryInsets = null
        availableInsets = null
        insetsHost?.let {
            it.removeOnLayoutChangeListener(hostLayoutListener)
            ViewCompat.setOnApplyWindowInsetsListener(it, null)
            ViewCompat.setWindowInsetsAnimationCallback(it, null)
        }
        insetsHost = null
        mobileShareImageDocumentOwner.detach()
        super.onDestroy()
    }

    override fun onWebViewCreate(webView: WebView) {
        StartupLog.webViewCreated()
        super.onWebViewCreate(webView)
        clearStartupAttachListener()
        clearStartupBackdrop()
        activeReplyProxy = null
        mainWebView?.removeOnLayoutChangeListener(gestureLayoutListener)
        mainWebView = webView
        webView.setBackgroundColor(Color.TRANSPARENT)
        webView.addOnLayoutChangeListener(gestureLayoutListener)
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
        val isDebug = isDebugBuild()
        val trustedOrigins = AndroidNativeBridge.allowedOriginRules(isDebug)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(
                webView,
                AndroidNativeBridge.BRIDGE_NAME,
                trustedOrigins,
            ) { view, message, sourceOrigin, isMainFrame, replyProxy ->
                if (!isMainFrame || isDestroyed || isFinishing || mainWebView !== view) return@addWebMessageListener
                if (!AndroidNativeBridge.isAllowedOrigin(sourceOrigin.toString(), isDebug)) return@addWebMessageListener
                when (val parsed = AndroidNativeBridge.parseMessage(message.data)) {
                    is AndroidNativeBridge.BridgeMessage.Bootstrap -> {
                        activeReplyProxy = replyProxy
                        pushNativeState(replyProxy)
                    }
                    is AndroidNativeBridge.BridgeMessage.Theme -> {
                        val background = parsed.backgroundHex?.let { Color.parseColor(it) }
                        applyWindowTheme(parsed.dark, background)
                    }
                    null -> {}
                }
            }
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(
                webView,
                AndroidNativeBridge.BRIDGE_AND_THEME_SCRIPT,
                trustedOrigins,
            )
        }

        pendingCrashNavigationUrl?.let { targetUrl ->
            pendingCrashNavigationUrl = null
            startupFrameReady = true
            isReady = true
            clearStartupBackdrop()
            clearStartupAttachListener()
            webView.post {
                if (mainWebView === webView && !isDestroyed && !isFinishing) {
                    webView.loadUrl(targetUrl)
                }
            }
        }
    }

    internal fun handleWebViewRenderProcessGone(deadWebView: WebView) {
        runOnUiThread {
            if (isDestroyed || isFinishing || mainWebView !== deadWebView) return@runOnUiThread
            clearStartupAttachListener()
            activeReplyProxy = null
            deadWebView.removeOnLayoutChangeListener(gestureLayoutListener)
            mainWebView = null
            (deadWebView.parent as? ViewGroup)?.removeView(deadWebView)
            deadWebView.destroy()
            recreate()
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
        val root = webView.rootView
        val location = IntArray(2)
        val rootLocation = IntArray(2)
        parent.getLocationInWindow(location)
        root.getLocationInWindow(rootLocation)
        val height = WebViewAvailableHeight.fromWindow(
            nativeWindowBounds().height(), parent.height - parent.paddingBottom,
            location[1] - rootLocation[1] + webView.top, webView.top,
            0,
        ) ?: return
        val params = webView.layoutParams
        if (params.height != height) {
            params.height = height
            webView.layoutParams = params
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
        val windowBounds = nativeWindowBounds()
        val viewTop = location[1] - rootLocation[1]
        val geometry = WebViewGeometry.fromWindow(
            windowBounds.width(), windowBounds.height(), location[0] - rootLocation[0], viewTop,
            webView.width, webView.height, chrome.left, chrome.top, chrome.right, chrome.bottom,
        ) ?: return
        val nextGeometry = geometry.toJson(windowBounds.height(), chrome.bottom, viewTop)
        if (geometryJson != nextGeometry) {
            geometryJson = nextGeometry
            pushNativeState()
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
        val windowBounds = nativeWindowBounds()
        val nextRegion = SystemGestureRegion.fromWindow(
            windowBounds.width(), location[0] - rootLocation[0], webView.width, insets.left, insets.right,
        )?.toJson() ?: "null"
        if (systemGestureRegionJson != nextRegion) {
            systemGestureRegionJson = nextRegion
            pushNativeState()
        }
    }

    private fun isDebugBuild(): Boolean =
        (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    private fun currentKeyboardViewportWidth(): Int =
        mainWebView?.width?.takeIf { it > 0 } ?: nativeWindowBounds().width().coerceAtLeast(0)

    private fun emitKeyboardState(targetInset: Int, durationMs: Long, phase: String) {
        val clampedInset = targetInset.coerceAtLeast(0)
        val viewportWidth = currentKeyboardViewportWidth()
        if (viewportWidth <= 0) return
        val settled = phase == "settled"
        if (settled && lastSentKeyboardSettled &&
            clampedInset == lastSentKeyboardInset &&
            viewportWidth == lastSentKeyboardViewportWidth &&
            keyboardSequence > 0L
        ) {
            return
        }
        keyboardSequence += 1L
        lastSentKeyboardInset = clampedInset
        lastSentKeyboardViewportWidth = viewportWidth
        lastSentKeyboardSettled = settled
        keyboardJson = AndroidNativeBridge.KeyboardOverlayPacket(
            targetInset = clampedInset,
            viewportWidth = viewportWidth,
            durationMs = if (settled) 0L else durationMs,
            easing = AndroidNativeBridge.DEFAULT_KEYBOARD_EASING,
            phase = phase,
            sequence = keyboardSequence,
        ).toJson()
        pushNativeState()
    }

    private fun pushNativeState(target: JavaScriptReplyProxy? = activeReplyProxy) {
        if (isDestroyed || isFinishing || mainWebView == null || target == null) return
        val width = currentKeyboardViewportWidth()
        if (keyboardSequence == 0L && width > 0) {
            lastSentKeyboardViewportWidth = width
            keyboardJson = AndroidNativeBridge.settledOverlayKeyboardJson(lastAppliedImeInset, width, 0L)
        }
        val payload = AndroidNativeBridge.buildSnapshotPayload(geometryJson, systemGestureRegionJson, keyboardJson)
        runOnUiThread {
            if (isDestroyed || isFinishing || mainWebView == null) return@runOnUiThread
            try {
                target.postMessage(payload)
            } catch (_: Throwable) {
            }
        }
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
}
