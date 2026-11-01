buildscript {
    val alookToolchain = java.util.Properties().apply {
        rootProject.file("gradle.properties").inputStream().use { load(it) }
    }
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:${alookToolchain.getProperty("alook.agp")}")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:${alookToolchain.getProperty("alook.kotlin")}")
        classpath("com.google.gms:google-services:4.5.0")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}
