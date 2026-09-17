import java.util.Properties
import org.gradle.api.GradleException

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val generatedWebViewClient = file("src/main/java/ai/alook/android/generated/RustWebViewClient.kt")
val modernErrorMethod = """
    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
    ) {
""".trim('\n')
val modernRecoveryDispatch = """
        if (
            request.isForMainFrame &&
            WebviewRecovery.handleError(
                view,
                error.errorCode,
                currentUrl,
                request.url.toString(),
            )
        ) {
            return
        }

""".trim('\n')
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
""".trim('\n')

fun String.occurrencesOf(value: String): Int = windowed(value.length).count { it == value }

fun wireGeneratedWebViewRecovery(sourceFile: File) {
    var source = sourceFile.readText()
    if (!source.contains(modernRecoveryDispatch)) {
        if (source.occurrencesOf(modernErrorMethod) != 1) {
            throw GradleException("Wry RustWebViewClient modern error callback changed")
        }
        source = source.replace(modernErrorMethod, modernErrorMethod + "\n" + modernRecoveryDispatch)
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
        "modern main-frame recovery dispatch" to
            (modernErrorMethod + "\n" + modernRecoveryDispatch),
        "legacy recovery dispatch" to
            "WebviewRecovery.handleError(view, errorCode, currentUrl, failingUrl)",
        "SSL recovery dispatch" to
            "WebviewRecovery.handleSslError(view, currentUrl, error.url)",
        "Wry fallback" to "super.onReceivedError(view, request, error)",
    )
    val missing = required.filterNot { source.contains(it.second) }.map { it.first }
    if (missing.isNotEmpty()) {
        throw GradleException("Generated RustWebViewClient recovery gate failed: ${missing.joinToString()}")
    }
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "ai.alook.android"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "ai.alook.android"
        minSdk = 24
        targetSdk = 36
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
            applicationIdSuffix = ".qa.madox.nav112v2local"
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
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")

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
