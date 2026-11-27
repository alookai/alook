import java.util.Properties
import org.gradle.api.GradleException

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val alookToolchain = Properties().apply {
    rootProject.file("gradle.properties").inputStream().use { load(it) }
}

val generatedWebViewClient = file("src/main/java/ai/alook/android/generated/RustWebViewClient.kt")
val modernErrorFallback = """
        } else {
            super.onReceivedError(view, request, error)
        }
""".trim('\n')
val modernRecoveryFallback = """
        } else if (
            request.isForMainFrame &&
            WebviewRecovery.handleMainFrameError(
                view,
                error.errorCode,
                request.url.toString(),
            )
        ) {
            return
        } else {
            super.onReceivedError(view, request, error)
        }
""".trim('\n')
val originalPageStartedCallback = """
    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        currentUrl = url
        if (interceptedState[url] == false) {
            val webView = view as RustWebView
            for (script in webView.initScripts) {
                view.evaluateJavascript(script, null)
            }
        }
        return Rust.onPageLoading((view as RustWebView).id, url)
    }
""".trim('\n')
val exclusivePageStartedCallback = originalPageStartedCallback.replace(
    "        currentUrl = url",
    "        currentUrl = url\n        WebviewRecovery.recordAllowedUrl(url)",
).replace(
    "if (interceptedState[url] == false)",
    "if (interceptedState[url] == false && !(view as RustWebView).isDocumentStartScriptEnabled)",
)
val pageLoadedCall = "        Rust.onPageLoaded((view as RustWebView).id, url)"
val legacyAndSslRecoveryDispatch = "\n\n" + """
    @Suppress("DEPRECATION")
    override fun onReceivedError(
        view: WebView,
        errorCode: Int,
        description: String?,
        failingUrl: String?
    ) {
        if (!WebviewRecovery.handleError(view, errorCode, currentUrl, failingUrl)) {
            super.onReceivedError(view, errorCode, description, failingUrl)
        }
    }

    override fun onReceivedSslError(
        view: WebView,
        handler: SslErrorHandler,
        error: android.net.http.SslError
    ) {
        handler.cancel()
        WebviewRecovery.handleSslError(view, currentUrl, error.url)
    }

    override fun onRenderProcessGone(
        view: WebView,
        detail: android.webkit.RenderProcessGoneDetail
    ): Boolean {
        return WebviewRecovery.handleRenderProcessGone(view, currentUrl, detail.didCrash())
    }
""".trim('\n')

fun String.occurrencesOf(value: String): Int = windowed(value.length).count { it == value }

fun wireGeneratedWebViewRecovery(sourceFile: File) {
    var source = sourceFile.readText()
    if (listOf("handlePageCommitVisible", "handlePageStarted", "handlePageFinished").any(source::contains)) {
        throw GradleException("Stale Wry page-ready callback; regenerate RustWebViewClient")
    }
    if (source.occurrencesOf(originalPageStartedCallback) + source.occurrencesOf(exclusivePageStartedCallback) != 1) {
        throw GradleException("Wry RustWebViewClient initialization callback changed")
    }
    source = source.replace(originalPageStartedCallback, exclusivePageStartedCallback)
    if (!source.contains(modernRecoveryFallback)) {
        if (source.occurrencesOf(modernErrorFallback) != 1) {
            throw GradleException("Wry RustWebViewClient modern error callback changed")
        }
        source = source.replace(modernErrorFallback, modernRecoveryFallback)
    }
    if (!source.contains("WebviewRecovery.handleError(view, errorCode, currentUrl, failingUrl)")) {
        val classEnd = source.lastIndexOf("\n}")
        if (classEnd < 0) {
            throw GradleException("Wry RustWebViewClient class boundary is missing")
        }
        source = source.substring(0, classEnd) + legacyAndSslRecoveryDispatch + source.substring(classEnd)
    }
    sourceFile.writeText(source)
}

fun verifyGeneratedWebViewRecovery(sourceFile: File) {
    val source = sourceFile.readText()
    val required = listOf(
        "exclusive remote initialization callback" to exclusivePageStartedCallback,
        "modern main-frame recovery fallback" to modernRecoveryFallback,
        "legacy recovery dispatch" to
            "WebviewRecovery.handleError(view, errorCode, currentUrl, failingUrl)",
        "SSL recovery dispatch" to
            "WebviewRecovery.handleSslError(view, currentUrl, error.url)",
        "render process crash recovery dispatch" to
            "WebviewRecovery.handleRenderProcessGone(view, currentUrl, detail.didCrash())",
        "Wry fallback" to "super.onReceivedError(view, request, error)",
    )
    val missing = required.filterNot { source.occurrencesOf(it.second) == 1 }.map { it.first }
    if (missing.isNotEmpty()) {
        throw GradleException("Generated RustWebViewClient recovery gate failed: ${missing.joinToString()}")
    }
    val originalCalls = listOf(
        "currentUrl = url",
        "for (script in webView.initScripts)",
        "return Rust.onPageLoading((view as RustWebView).id, url)",
        pageLoadedCall,
        modernRecoveryFallback,
    )
    if (originalCalls.any { source.occurrencesOf(it) != 1 } || listOf("handlePageCommitVisible", "handlePageStarted", "handlePageFinished").any(source::contains)) {
        throw GradleException("Generated RustWebViewClient lost Wry startup behavior")
    }
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = alookToolchain.getProperty("alook.compileSdk").toInt()
    buildToolsVersion = alookToolchain.getProperty("alook.buildTools")
    ndkVersion = alookToolchain.getProperty("alook.ndk")
    namespace = "ai.alook.android"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "ai.alook.android"
        minSdk = 24
        targetSdk = alookToolchain.getProperty("alook.compileSdk").toInt()
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            val keystorePropsFile = file("keystore.properties")
            if (keystorePropsFile.exists()) {
                val keystoreProps = Properties().apply {
                    keystorePropsFile.inputStream().use { load(it) }
                }
                storeFile = file(keystoreProps.getProperty("storeFile").trim())
                storePassword = keystoreProps.getProperty("storePassword").trim()
                keyAlias = keystoreProps.getProperty("keyAlias").trim()
                keyPassword = keystoreProps.getProperty("keyPassword").trim()
            } else {
                storeFile = System.getenv("SIGNING_STORE_FILE")?.let { file(it) }
                storePassword = System.getenv("SIGNING_STORE_PASSWORD")
                keyAlias = System.getenv("SIGNING_KEY_ALIAS")
                keyPassword = System.getenv("SIGNING_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))

listOf(
    "UniversalDebug",
    "UniversalRelease",
    "Arm64Debug",
    "Arm64Release",
    "ArmDebug",
    "ArmRelease",
    "X86Debug",
    "X86Release",
    "X86_64Debug",
    "X86_64Release",
).forEach { variant ->
    tasks.matching { it.name == "rustBuild$variant" }.configureEach {
        doLast {
            synchronized(project) {
                wireGeneratedWebViewRecovery(generatedWebViewClient)
            }
        }
    }
    val verify = tasks.register("verify${variant}WebviewRecovery") {
        mustRunAfter("rustBuild$variant")
        doLast {
            verifyGeneratedWebViewRecovery(generatedWebViewClient)
        }
    }
    tasks.matching { it.name == "compile${variant}Kotlin" }.configureEach {
        dependsOn(verify)
    }
}

if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
