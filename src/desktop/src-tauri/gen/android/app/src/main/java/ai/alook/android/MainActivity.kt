package ai.alook.android

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
    private var isReady = false

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

        splashScreen.setKeepOnScreenCondition { !isReady }

        Handler(Looper.getMainLooper()).postDelayed({ isReady = true }, 2000)

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
            WindowInsetsCompat.Builder(insets)
                .setInsets(chromeTypes, Insets.NONE)
                .setInsets(imeType, Insets.of(imeInsets.left, imeInsets.top, imeInsets.right, 0))
                .build()
        }
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        webView.addJavascriptInterface(ThemeBridge(this), "AlookNative")

        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, THEME_OBSERVER_SCRIPT, setOf("*"))
        }
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
