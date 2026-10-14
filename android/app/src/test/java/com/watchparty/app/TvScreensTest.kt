package com.watchparty.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The TV home, pages and side menu, driven with remote keys against a pretend server. Screenshots of each step land
 * in build/tv-screens (CI keeps them), so the TV layout can be checked without a TV.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi-land-television")
class TvScreensTest {
    @get:Rule
    val rule = createComposeRule()
    private val server = MockWebServer()
    private val out = File("build/tv-screens").apply { mkdirs() }

    private val colors = listOf(0xFF2E6F8E, 0xFF8E4A2E, 0xFF4A8E2E, 0xFF6A2E8E, 0xFF8E2E5A, 0xFF2E8E7A).map { it.toInt() }

    private fun movie(n: Int, title: String) = MediaItem(
        id = "m$n", title = title, relPath = "Movies/$title.mkv", folder = "Movies", size = 4_000_000_000, addedAt = 1000L - n, duration = 7000.0,
        meta = MediaMeta(tmdbId = n.toLong(), title = title, year = 2020 + n % 5, overview = "A sample movie for the screen tests.", posterPath = "/p$n.jpg", backdropPath = "/b$n.jpg", rating = 7.5, genres = listOf("Drama")),
    )

    private fun episode(show: String, n: Int, season: Int, ep: Int) = MediaItem(
        id = "e$n$season$ep", title = "$show S${season}E$ep", relPath = "TV/$show/S$season/E$ep.mkv", folder = "TV/$show", size = 1_000_000_000, addedAt = 900L - n, duration = 3000.0,
        episode = EpisodeInfo(show, season, ep),
        meta = MediaMeta(tmdbId = 100L + n, title = "Episode $ep", overview = "Mark leads a team whose memories have been split between work and home.", stillPath = "/s$n$ep.jpg", show = show, showPosterPath = "/sp$n.jpg", showOverview = "A sample show for the screen tests.", backdropPath = "/sb$n.jpg", rating = 8.4, genres = listOf("Drama", "Mystery")),
    )

    private val items = listOf("Arrival", "Dune: Part Two", "Inception", "Heat", "Alien", "Grindhouse", "Up", "Moon").mapIndexed { i, t -> movie(i, t) } +
        listOf("Severance", "The Bear", "Letterkenny").flatMapIndexed { n, show -> (1..2).flatMap { s -> (1..4).map { e -> episode(show, n, s, e) } } }

    private fun png(seed: Int): Buffer {
        val bitmap = Bitmap.createBitmap(300, 300, Bitmap.Config.ARGB_8888)
        val paint = Paint().apply { shader = LinearGradient(0f, 0f, 300f, 300f, colors[seed % colors.size], colors[(seed + 2) % colors.size], Shader.TileMode.CLAMP) }
        Canvas(bitmap).drawRect(0f, 0f, 300f, 300f, paint)
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        return Buffer().write(bytes)
    }

    @Before
    fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                return when {
                    path.startsWith("/api/library") -> json("""{"items":${Protocol.json.encodeToString(items)}}""")
                    path.startsWith("/api/rooms") -> json("""{"rooms":[]}""")
                    path.startsWith("/api/spots") -> json("""{"spots":[]}""")
                    path.startsWith("/api/images/") -> MockResponse().setHeader("Content-Type", "image/png").setBody(png(path.hashCode() and 0xFF))
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        val prefs = Prefs(ApplicationProvider.getApplicationContext())
        prefs.serverUrl = server.url("/").toString().trimEnd('/')
        prefs.token = "test"
        prefs.name = "Jake"
        prefs.markSignedIn(true)
        rule.setContent {
            PopcornTheme {
                Box(Modifier.fillMaxSize().background(Bg)) { Dashboard(prefs, onSignedOut = {}, forceTv = true) }
            }
        }
        rule.waitUntil(15_000) { rule.onAllNodesWithText("Recently added").fetchSemanticsNodes().isNotEmpty() }
        // Let the posters arrive.
        Thread.sleep(1500)
        rule.mainClock.advanceTimeBy(500)
        rule.waitForIdle()
    }

    @After
    fun stop() = server.shutdown()

    private fun shot(name: String) {
        rule.waitForIdle()
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(out, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun press(key: Key, times: Int = 1) = repeat(times) {
        rule.onRoot().performKeyInput { pressKey(key) }
        rule.mainClock.advanceTimeBy(400)
        rule.waitForIdle()
    }

    /** The side menu is open (its labels show) only while the remote is on it. */
    private fun menuOpen() = rule.onAllNodesWithText("Join with code").fetchSemanticsNodes().isNotEmpty()

    @Test
    fun theRemoteGetsInAndOutOfTheMenu() {
        shot("01-home")
        press(Key.DirectionDown)
        shot("02-home-first-card")
        press(Key.DirectionLeft)
        assertTrue("Left from the first card opens the menu", menuOpen())
        shot("03-menu")
        // Home, Movies: down twice from wherever it landed is not certain, so go to the top first.
        press(Key.DirectionUp, 8)
        press(Key.DirectionDown, 2)
        shot("04-menu-on-movies")
        press(Key.DirectionCenter)
        shot("05-movies")
        press(Key.DirectionRight)
        shot("06-movies-right")
        assertTrue("Right from the menu on Movies reaches the page", !menuOpen())
    }

    @Test
    fun showPage() {
        // TV Shows from the menu, then the first show.
        press(Key.DirectionLeft)
        press(Key.DirectionUp, 8)
        press(Key.DirectionDown, 3)
        press(Key.DirectionCenter)
        shot("10-shows")
        press(Key.DirectionRight)
        press(Key.DirectionCenter)
        shot("11-show-page")
        press(Key.DirectionUp)
        shot("12-show-page-up")
        assertTrue("Up from Binge stays on the page", !menuOpen())
    }
}
