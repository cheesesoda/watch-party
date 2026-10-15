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
import androidx.activity.ComponentActivity
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performSemanticsAction
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasClickAction
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
 * The phone's home and pages while watching alone, against the same pretend server. Screenshots land beside the TV ones
 * in build/tv-screens.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-port-xxhdpi")
class PhoneScreensTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()
    private lateinit var focus: FocusManager
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
        prefs.alone = true
        // A TV has no touch screen: out of touch mode, and with the window focused, the remote's focus works.
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        // The banner and progress keep asking for frames, so the clock only moves when told to.
        rule.mainClock.autoAdvance = false
        rule.setContent {
            focus = LocalFocusManager.current
            // Clickable things only take focus while a remote or keyboard is in use, not in touch mode.
            val inputMode = LocalInputModeManager.current
            androidx.compose.runtime.SideEffect { @OptIn(ExperimentalComposeUiApi::class) inputMode.requestInputMode(InputMode.Keyboard) }
            PopcornTheme {
                Box(Modifier.fillMaxSize().background(Bg)) { Dashboard(prefs, onSignedOut = {}) }
            }
        }
        rule.runOnIdle { rule.activity.window.decorView.dispatchWindowFocusChanged(true) }
        settle { rule.onAllNodesWithText("Recently added").fetchSemanticsNodes().isNotEmpty() }
        // Let the posters arrive.
        settle(2_000) { false }
    }

    /** Runs the app (network threads, main looper, a moving clock) until [done] or [ms] pass. */
    private fun settle(ms: Long = 15_000, done: () -> Boolean) {
        val until = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < until) {
            Thread.sleep(50)
            rule.mainClock.advanceTimeBy(50)
            rule.waitForIdle()
            if (done()) return
        }
        if (ms >= 5_000) throw AssertionError("Gave up waiting after $ms ms")
    }

    @After
    fun stop() = server.shutdown()

    private fun shot(name: String) {
        rule.mainClock.advanceTimeBy(600)
        rule.waitForIdle()
        val view = rule.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        rule.runOnIdle { view.draw(Canvas(bitmap)) }
        File(out, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun tap(text: String) {
        rule.onAllNodes(hasText(text) and hasClickAction())[0].performSemanticsAction(SemanticsActions.OnClick)
        settle(800) { false }
    }

    @Test
    fun watchingAlone() {
        shot("p01-home-alone")
        assertTrue("No Watching alone line", rule.onAllNodesWithText("Watching alone").fetchSemanticsNodes().isNotEmpty())
        rule.onNodeWithContentDescription("More").performSemanticsAction(SemanticsActions.OnClick)
        settle(800) { false }
        shot("p02-menu")
        rule.runOnIdle { rule.activity.onBackPressedDispatcher.onBackPressed() }
        settle(800) { false }
        tap("TV Shows")
        shot("p03-shows")
        tap("Letterkenny")
        shot("p04-show-alone")
    }
}
