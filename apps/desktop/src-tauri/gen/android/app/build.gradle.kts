import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing — read from keystore.properties (local dev, gitignored) or ANDROID_KEYSTORE_* env
// vars (Gitea CI, injected as secrets). Passwords never live in git. If neither source is present the
// "release" signingConfig simply isn't created, so debug builds are unaffected.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}
fun signingValue(propKey: String, envKey: String): String? =
    keystoreProperties.getProperty(propKey) ?: System.getenv(envKey)
val releaseStoreFile = signingValue("storeFile", "ANDROID_KEYSTORE_PATH")

// Магазинный вариант (#247): `GV_STORE=play` в окружении сборки → сборка для Google Play — пуши через Google FCM
// (`src/play/java`: `StorePush.kt`, `FcmService.kt`), встроенный WS-распространитель и его перезапуск после загрузки
// вычеркнуты наложением манифеста `src/play/AndroidManifest.xml`. Иначе — F-Droid: `src/fdroid/java` (заглушка
// `StorePush`), ни одной библиотеки Google. Не productFlavors: tauri CLI зовёт задачи Gradle по своим именам
// (`assembleUniversalRelease`…), новое измерение вкусов их переименовало бы.
val isPlayStore = System.getenv("GV_STORE") == "play"
// Firebase без плагина google-services: параметры проекта — из окружения сборки в `BuildConfig`, `StorePush` поднимает
// FirebaseApp вручную. Пустое — сборка падает: AAB без пушей хуже, чем красная сборка.
val playEnvKeys = listOf(
    "GV_FIREBASE_APP_ID", "GV_FIREBASE_API_KEY", "GV_FIREBASE_PROJECT_ID", "GV_FIREBASE_SENDER_ID", "GV_FCM_RELAY",
)
val playEnv: Map<String, String> = if (!isPlayStore) emptyMap() else playEnvKeys.associateWith { key ->
    val value = System.getenv(key).orEmpty().trim()
    if (value.isEmpty()) {
        throw GradleException(
            "GV_STORE=play: env $key is empty. Google Play build needs ${playEnvKeys.joinToString()} (FCM push).",
        )
    }
    if (value.any { it == '"' || it == '\\' || it == '\n' }) {
        throw GradleException("GV_STORE=play: env $key has a quote, backslash or newline")
    }
    value
}

android {
    compileSdk = 36
    namespace = "tech.gusik.gusvoice"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "tech.gusik.gusvoice"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        for ((key, value) in playEnv) buildConfigField("String", key, "\"$value\"")
    }
    sourceSets {
        // Одно имя класса `StorePush` в двух каталогах — подключается ровно один, main на Firebase не ссылается.
        getByName("main").java.srcDir(if (isPlayStore) "src/play/java" else "src/fdroid/java")
        if (isPlayStore) {
            // Наложение, а не замена: манифест набора исходников сборочного типа (`src/<тип>/AndroidManifest.xml` по
            // умолчанию — у нас таких каталогов нет) сливается поверх main с бОльшим приоритетом, `tools:node="remove"`
            // вычёркивает узлы main. Оба типа — чтобы отладочная play-сборка вела себя как выпускная.
            getByName("debug").manifest.srcFile("src/play/AndroidManifest.xml")
            getByName("release").manifest.srcFile("src/play/AndroidManifest.xml")
        }
    }
    signingConfigs {
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = signingValue("storePassword", "ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "ANDROID_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "ANDROID_KEY_PASSWORD")
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
            // Minify OFF: the @JavascriptInterface bridge (GusVoiceNative) + the foreground service are
            // invoked by name / from the manifest, so R8 without curated keep-rules can strip them. APK
            // size is dominated by native .so (libwebrtc/rnnoise/df), so R8 would save almost nothing.
            isMinifyEnabled = false
            signingConfigs.findByName("release")?.let { signingConfig = it }
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
    // UnifiedPush client — receive push via the ntfy distributor even when our process is dead. Pinned
    // to the v2.x API (MessagingReceiver: endpoint=String, message=ByteArray); v3 deprecates it for a
    // PushService redesign with PushEndpoint/PushMessage objects — simpler to keep v2 for a WebView shell.
    implementation("org.unifiedpush.android:connector:2.5.0")
    // OkHttp — WebSocket client for the EMBEDDED push distributor (PushDistributorService holds a
    // socket to the instance's ntfy so DMs/@mentions wake the app with no separate ntfy app). Pinned.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Google FCM — только в сборке для Google Play (#247). F-Droid-сборка не тянет ни одной библиотеки Google
    // (Firebase/Play services). Закреплено точно. 25.1.x, а не 26.x: 26 собрана Kotlin 2.1 (метаданные 2.1), а проект —
    // на Kotlin 1.9.25 (корневой build.gradle.kts), тот читает метаданные не новее 2.0. `GoogleApiAvailability` —
    // play-services-base той же версии, что тянет firebase-messaging 25.1.3 (у неё она не в compile-зависимостях).
    if (isPlayStore) {
        implementation("com.google.firebase:firebase-messaging:25.1.3")
        implementation("com.google.android.gms:play-services-base:18.9.0")
    }
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")