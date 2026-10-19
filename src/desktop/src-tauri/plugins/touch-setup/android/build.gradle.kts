plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "ai.alook.plugin.touchsetup"
    compileSdk = 36
    defaultConfig { minSdk = 24; consumerProguardFiles("proguard-rules.pro") }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_1_8; targetCompatibility = JavaVersion.VERSION_1_8 }
    kotlinOptions { jvmTarget = "1.8" }
}
dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
    implementation("com.github.espressif:esp-idf-provisioning-android:lib-2.4.4")
}
