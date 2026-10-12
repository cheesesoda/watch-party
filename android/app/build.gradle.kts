plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.watchparty.app"
    compileSdk = 36

    defaultConfig {
        // Play identity: permanent once the first build is uploaded to Play Console.
        applicationId = "com.cheeseparty.app"
        minSdk = 26
        targetSdk = 36
        // Where Join a party looks for parties unless someone picks "Other server". Override with -PdefaultServer=…
        val defaultServer = (project.findProperty("defaultServer") as String?) ?: "https://omnipotent.tail3b2bb0.ts.net"
        buildConfigField("String", "DEFAULT_SERVER", "\"$defaultServer\"")
        // The TV's sign-in QR code links to <server>/pair/…; phones with the app open it here.
        manifestPlaceholders["pairHost"] = defaultServer.substringAfter("://").substringBefore("/").substringBefore(":")
        // The release workflow passes these; local and PR builds use the defaults.
        versionCode = (findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = findProperty("versionName") as String? ?: "0.1.0"
    }

    // Upload key for Google Play, supplied only by the release workflow (never committed).
    val uploadKeystore = System.getenv("ANDROID_KEYSTORE_FILE")
    signingConfigs {
        if (uploadKeystore != null) {
            create("upload") {
                storeFile = file(uploadKeystore)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Without the upload key, fall back to the debug key so the APK installs without extra setup.
            signingConfig = signingConfigs.findByName("upload") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    val media3 = "1.5.1"
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Draws the TV's sign-in QR code.
    implementation("com.google.zxing:core:3.5.3")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    // Community build of Google's WebRTC for voice chat; Google no longer publishes Android binaries.
    implementation("io.getstream:stream-webrtc-android:1.3.10")

    testImplementation("junit:junit:4.13.2")
}
