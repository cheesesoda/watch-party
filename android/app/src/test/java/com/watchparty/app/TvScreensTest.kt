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
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performSemanticsAction
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.test.onAllNodesWithText
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
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-land-television-xhdpi")
class TvScreensTest {
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
        meta = MediaMeta(tmdbId = 100L + n, title = "Episode $ep", overview = "Mark leads a team whose memories have been split between work and home.", stillPath = "/s$n$ep.jpg", show = show, showPosterPath = "/sp$n.jpg", showOverview = "A sample show for the screen tests, with a summary long enough to wrap onto three lines like a real one does, so the page is taller than the screen and has to scroll down to the episodes and back up again to the buttons.", backdropPath = "/sb$n.jpg", rating = 8.4, genres = listOf("Drama", "Mystery")),
    )

    private val items = listOf("Arrival", "Dune: Part Two", "Inception", "Heat", "Alien", "Grindhouse", "Up", "Moon").mapIndexed { i, t -> movie(i, t) } +
        listOf("Severance", "The Bear", "Letterkenny").flatMapIndexed { n, show -> (1..2).flatMap { s -> (1..4).map { e -> episode(show, n, s, e) } } }

    /** Saved spots: two movies, so removing one leaves a neighbor. */
    private val spots = listOf(Spot("s1", items[0], 1200.0, savedAt = 2000), Spot("s2", items[1], 3000.0, savedAt = 1990))

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
                    path.startsWith("/api/spots/") -> json("{}")
                    path.startsWith("/api/spots") -> json("""{"spots":${Protocol.json.encodeToString(spots)}}""")
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
                Box(Modifier.fillMaxSize().background(Bg)) { Dashboard(prefs, onSignedOut = {}, forceTv = true) }
            }
        }
        rule.runOnIdle { rule.activity.window.decorView.dispatchWindowFocusChanged(true) }
        // With saved spots, Recently added sits below the fold, so either row means Home is up.
        settle { onHome() }
        // Let the posters arrive.
        settle(2_000) { false }
    }

    private fun onHome() = listOf("Pick up where you left off", "Recently added").any { rule.onAllNodesWithText(it).fetchSemanticsNodes().isNotEmpty() }

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

    /** The remote's arrow keys (key events don't reach the app under Robolectric, so focus moves the same way they would). */
    private fun press(direction: FocusDirection, times: Int = 1) = repeat(times) {
        rule.runOnIdle { focus.moveFocus(direction) }
        settle(400) { false }
    }

    /** OK on the remote. */
    private fun ok() {
        rule.onNode(isFocused()).performSemanticsAction(SemanticsActions.OnClick)
        settle(800) { false }
    }

    private val problems = mutableListOf<String>()

    /** Noted rather than thrown, so the rest of the screenshots still get taken. */
    private fun check(ok: Boolean, problem: String) {
        if (!ok) problems += problem
    }

    /** The side menu is open (its labels show) only while the remote is on it. */
    private fun menuOpen() = rule.onAllNodesWithText("Join with code").fetchSemanticsNodes().isNotEmpty()

    @Test
    fun theRemoteGetsInAndOutOfTheMenu() {
        shot("01-home")
        press(FocusDirection.Down)
        shot("02-home-first-card")
        press(FocusDirection.Left)
        check(menuOpen(), "Left from the first card didn't open the menu")
        shot("03-menu")
        rule.runOnIdle { rule.activity.onBackPressedDispatcher.onBackPressed() }
        settle(800) { false }
        check(!menuOpen(), "Back in the menu didn't close it")
        check(onHome(), "Back in the menu left Home")
        shot("03b-menu-back")
        press(FocusDirection.Left)
        // Home, Movies: down twice from wherever it landed is not certain, so go to the top first.
        press(FocusDirection.Up, 8)
        press(FocusDirection.Down, 2)
        shot("04-menu-on-movies")
        ok()
        shot("05-movies")
        press(FocusDirection.Right)
        shot("06-movies-right")
        check(!menuOpen(), "Right from the menu on Movies didn't reach the page")
        press(FocusDirection.Up, 4)
        shot("06b-movies-top")
        check(!menuOpen(), "Up at the top of Movies went into the menu")
        rule.runOnIdle { rule.activity.onBackPressedDispatcher.onBackPressed() }
        settle(800) { false }
        shot("07-movies-back")
        check(onHome(), "Back on Movies didn't go Home")
        assertTrue(problems.joinToString("; "), problems.isEmpty())
    }

    @Test
    fun removingASpotStaysOnThePage() {
        // Banner, then down to Pick up where you left off.
        press(FocusDirection.Down)
        shot("30-spot-focused")
        ok()
        rule.onAllNodesWithText("Remove")[0].performSemanticsAction(SemanticsActions.OnClick)
        settle(1_500) { false }
        shot("31-spot-removed")
        check(!menuOpen(), "Removing a spot opened the menu")
        assertTrue(problems.joinToString("; "), problems.isEmpty())
    }

    @Test
    fun settings() {
        press(FocusDirection.Left)
        press(FocusDirection.Down, 12)
        // Up from the bottom (Together / Alone) to Settings.
        press(FocusDirection.Up)
        shot("20-menu-on-settings")
        ok()
        shot("21-settings")
        check(rule.onAllNodesWithText("Sign out").fetchSemanticsNodes().isNotEmpty(), "Settings didn't open")
        assertTrue(problems.joinToString("; "), problems.isEmpty())
    }

    @Test
    fun showPage() {
        // TV Shows from the menu, then the first show.
        press(FocusDirection.Left)
        press(FocusDirection.Up, 8)
        press(FocusDirection.Down, 3)
        ok()
        shot("10-shows")
        // Right lands on the sort chips; Down reaches the first show.
        press(FocusDirection.Right)
        press(FocusDirection.Down)
        shot("10b-shows-first-card")
        ok()
        shot("11-show-page")
        press(FocusDirection.Up)
        shot("12-show-page-up")
        check(!menuOpen(), "Up from Binge went to the menu")
        // Down into the episodes and back up to Binge: the page scrolls back so the show's name isn't cut off.
        press(FocusDirection.Right)
        press(FocusDirection.Down, 2)
        shot("12b-show-episodes")
        press(FocusDirection.Up, 2)
        settle(1_000) { false }
        shot("12c-show-back-to-binge")
        check(rule.onAllNodesWithText("Binge all 2 seasons").fetchSemanticsNodes().isNotEmpty(), "The show's page didn't open")
        val top = rule.onAllNodesWithText("Letterkenny")[0].fetchSemanticsNode().boundsInRoot.top
        check(top >= 0f, "Back up to Binge left the show's name cut off (top $top)")
        // A page left scrolled down (like coming back from the player) with the remote on Binge scrolls back up.
        rule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollBy) and hasAnyDescendant(hasText("Letterkenny"))).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 150f) }
        settle(1_000) { false }
        shot("12d-show-scrolled-with-binge")
        val top2 = rule.onAllNodesWithText("Letterkenny")[0].fetchSemanticsNode().boundsInRoot.top
        check(top2 >= 0f, "A scrolled page with the remote on Binge left the show's name cut off (top $top2)")
        assertTrue(problems.joinToString("; "), problems.isEmpty())
    }
}
