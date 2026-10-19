plugins { `kotlin-dsl` }
repositories { google(); mavenCentral(); gradlePluginPortal(); maven { url = uri("https://jitpack.io") } }
val touchSdkAar = configurations.create("touchSdkAar") { isTransitive = false }
dependencies {
    implementation("com.android.tools.build:gradle:9.3.1")
    add(touchSdkAar.name, "com.github.espressif:esp-idf-provisioning-android:lib-2.4.4@aar")
    testImplementation(kotlin("test"))
    testImplementation("org.ow2.asm:asm-util:9.9.1")
}
tasks.test {
    useJUnitPlatform()
    doFirst { systemProperty("touchSdkAar", providers.gradleProperty("touchSdkAar").orElse(touchSdkAar.elements.map { it.single().asFile.absolutePath }).get()) }
}

val appBuild = file("../../src-tauri/gen/android/app/build.gradle.kts")
val generatedSource = layout.buildDirectory.dir("generated/source")
val extractActualFactory = tasks.register("extractActualFactory") {
    inputs.file(appBuild)
    outputs.dir(generatedSource)
    doLast {
        val source = appBuild.readText()
        val imports = source.lineSequence().filter { it.startsWith("import com.android.build.api.instrumentation.") || it.startsWith("import org.objectweb.asm.") }.joinToString("\n")
        val factory = "abstract class TouchSdkLogSanitizer" + source.substringAfter("abstract class TouchSdkLogSanitizer").substringBefore("\nandroidComponents {")
        val output = generatedSource.get().file("TouchSdkLogSanitizer.kt").asFile
        output.parentFile.mkdirs()
        output.writeText("package ai.alook.gradle\n" + imports + "\n" + factory)
    }
}
sourceSets.main { kotlin.srcDir(generatedSource) }
tasks.compileKotlin { dependsOn(extractActualFactory) }
