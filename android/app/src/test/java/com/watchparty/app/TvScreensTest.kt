package com.watchparty.app

import android.content.pm.PackageManager
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
import org.junit.rules.TestName
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.onRoot
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
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
    @get:Rule
    val testName = TestName()
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

    /**
     * Saved spots: movies, so removing one leaves a neighbor. The second and third have no TMDB art: the server grabs a
     * frame from the second's video, and the third's can't be read, so it shows its title.
     */
    private val spots = listOf(
        Spot("s1", items[0], 1200.0, savedAt = 2000),
        Spot("s2", items[1].copy(meta = null), 3000.0, savedAt = 1990),
        Spot("s3", items[2].copy(meta = null, title = "Inception"), 600.0, savedAt = 1980),
        // Letterkenny S1E2: its page has Continue binge and the spot over the buttons, so a taller header.
        Spot("s4", items[25], 900.0, savedAt = 1970),
    )

    /**
     * Tests that run as on a real Google TV, which reports leanback: there Compose scrolls whatever takes focus to 30%
     * down the screen (its pivot) instead of just enough to show it.
     */
    private val onALeanbackTv = setOf("showPageWithASpotOpensWithoutBouncing", "bingeStaysPutGoingToTheMenuAndBack", "episodeStaysPutGoingToTheMenuAndBack")

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
                    // Starting a party (here, from a saved spot): the host watching alone, straight to the player.
                    path.startsWith("/api/rooms") && request.method == "POST" -> json("""{"room":{"id":"abc123","solo":true}}""")
                    path.startsWith("/api/rooms") -> json("""{"rooms":[]}""")
                    path.startsWith("/api/spots/s2/frame.jpg") -> MockResponse().setHeader("Content-Type", "image/png").setBody(png(5))
                    path.endsWith("/frame.jpg") -> MockResponse().setResponseCode(404)
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
        if (testName.methodName in onALeanbackTv) {
            shadowOf(ApplicationProvider.getApplicationContext<android.app.Application>().packageManager).setSystemFeature(PackageManager.FEATURE_LEANBACK, true)
        }
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

    /**
     * Pick up where you left off → Start party here opens the player and takes the spot off Home, so the card the remote
     * was on is gone when the player closes. Coming back used to open the menu; it should stay on the page.
     */
    @Test
    fun backFromThePlayerStaysOnThePage() {
        press(FocusDirection.Down)
        ok()
        rule.onAllNodesWithText("Start party here")[0].performSemanticsAction(SemanticsActions.OnClick)
        settle(1_500) { false }
        // The player covers Home, then closes.
        rule.runOnIdle { rule.activity.window.decorView.dispatchWindowFocusChanged(false) }
        rule.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
        settle(1_000) { false }
        rule.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
        rule.runOnIdle { rule.activity.window.decorView.dispatchWindowFocusChanged(true) }
        settle(1_500) { false }
        shot("32-back-from-player")
        check(!menuOpen(), "Coming back from the player opened the menu")
        press(FocusDirection.Down)
        shot("33-back-from-player-down")
        check(!menuOpen(), "Down after coming back from the player opened the menu")
        assertTrue(problems.joinToString("; "), problems.isEmpty())
    }

    /** Left into the menu from a row further down Home, then the remote's Right, goes back to the same card. */
    @OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)
    @Test
    fun rightFromTheMenuReturnsToTheSameCard() {
        // Banner, Pick up where you left off, Recently added; then along it.
        press(FocusDirection.Down, 2)
        press(FocusDirection.Right)
        shot("08-recent-card")
        // Left along the row to its first card, then into the menu.
        var left: androidx.compose.ui.geometry.Rect? = null
        repeat(8) {
            if (!menuOpen()) {
                left = rule.onNode(isFocused()).fetchSemanticsNode().boundsInRoot
                press(FocusDirection.Left)
            }
        }
        check(menuOpen(), "Left along Recently added never reached the menu")
        // A real key press, which the menu turns into "back to where you were".
        rule.onRoot().performKeyInput { pressKey(androidx.compose.ui.input.key.Key.DirectionRight) }
        settle(800) { false }
        shot("09-back-from-menu")
        val after = rule.onAllNodes(isFocused()).fetchSemanticsNodes().firstOrNull()?.boundsInRoot
        check(!menuOpen(), "Right from the menu didn't leave it")
        check(after == left, "Right from the menu went to $after, not the card it left ($left)")
        assertTrue(problems.joinToString("; "), problems.isEmpty())
    }

    @Test
    fun settings() {
        press(FocusDirection.Left)
        press(FocusDirection.Down, 12)
        // The bottom row: Watch alone, off, then on.
        shot("22-menu-on-watch-alone")
        ok()
        shot("23-menu-watch-alone-on")
        check(menuOpen(), "Watch alone closed the menu")
        rule.onNode(isFocused()).performSemanticsAction(SemanticsActions.OnClick)
        settle(800) { false }
        // Up from Watch alone to Settings.
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
        val titleTop = rule.onAllNodesWithText("Letterkenny")[0].fetchSemanticsNode().boundsInRoot.top
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
        check(top == titleTop, "Back up to Binge left the page scrolled (name at $top, not $titleTop)")
        // A page left scrolled down (like coming back from the player) with the remote on Binge scrolls back up.
        rule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollBy) and hasAnyDescendant(hasText("Letterkenny"))).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 150f) }
        settle(1_000) { false }
        shot("12d-show-scrolled-with-binge")
        val top2 = rule.onAllNodesWithText("Letterkenny")[0].fetchSemanticsNode().boundsInRoot.top
        check(top2 == titleTop, "A scrolled page with the remote on Binge stayed scrolled (name at $top2, not $titleTop)")
        assertTrue(problems.joinToString("; "), problems.isEmpty())
    }

    /** TV Shows from the menu, then onto the first show's card (Letterkenny, which has a saved spot). */
    private fun toFirstShowCard() {
        press(FocusDirection.Left)
        press(FocusDirection.Up, 8)
        press(FocusDirection.Down, 3)
        ok()
        press(FocusDirection.Right)
        press(FocusDirection.Down)
    }

    private fun topOf(text: String) = rule.onAllNodesWithText(text).fetchSemanticsNodes().firstOrNull()?.boundsInRoot?.top

    /** Steps the clock one frame at a time, noting where [text] is on each frame. */
    private fun watch(text: String, frames: Int = 60): List<Float?> = List(frames) {
        rule.mainClock.advanceTimeByFrame()
        rule.waitForIdle()
        topOf(text)
    }

    /** Opening a show's page with a saved spot (a taller header) used to scroll it down and snap it back up. */
    @Test
    fun showPageWithASpotOpensWithoutBouncing() {
        toFirstShowCard()
        rule.onNode(isFocused()).performSemanticsAction(SemanticsActions.OnClick)
        val tops = mutableListOf<Float?>()
        repeat(90) {
            rule.mainClock.advanceTimeByFrame()
            rule.waitForIdle()
            if (rule.onAllNodesWithText("Continue binge").fetchSemanticsNodes().isNotEmpty()) tops += topOf("Letterkenny")
        }
        shot("40-show-page-with-spot")
        assertTrue("The show's page didn't open", tops.isNotEmpty())
        assertTrue("The show's page moved as it opened (name at ${tops.distinct()})", tops.distinct().size == 1 && tops[0] != null)
    }

    /** Left from the page into the menu and Back out of it (the same return as Right), noting [text] on every frame. */
    private fun intoTheMenuAndBack(text: String): List<Float?> {
        val tops = mutableListOf(topOf(text))
        rule.runOnIdle { focus.moveFocus(FocusDirection.Left) }
        tops += watch(text)
        check(menuOpen(), "Left didn't open the menu")
        rule.runOnIdle { rule.activity.onBackPressedDispatcher.onBackPressed() }
        tops += watch(text)
        check(!menuOpen(), "Back didn't leave the menu")
        return tops
    }

    /** The remote on Continue binge, into the menu and back: the page used to bounce on the way back. */
    @Test
    fun bingeStaysPutGoingToTheMenuAndBack() {
        toFirstShowCard()
        ok()
        settle(1_000) { false }
        check(rule.onAllNodes(isFocused() and hasText("Continue binge")).fetchSemanticsNodes().isNotEmpty(), "The remote isn't on Continue binge")
        val tops = intoTheMenuAndBack("Letterkenny")
        shot("41-binge-back-from-menu")
        check(tops.distinct().size == 1 && tops[0] != null, "The page moved going to the menu and back from Binge (name at ${tops.distinct()})")
        assertTrue(problems.joinToString("; "), problems.isEmpty())
    }

    /** The remote on an episode, into the menu and back: the card lost its summary and the page under it shifted. */
    @Test
    fun episodeStaysPutGoingToTheMenuAndBack() {
        toFirstShowCard()
        ok()
        // Down to the season chips, then the first episode.
        press(FocusDirection.Down, 2)
        settle(1_000) { false }
        val chip = topOf("Season 1")
        val card = rule.onNode(isFocused()).fetchSemanticsNode().boundsInRoot.top
        check(chip != null && card > chip, "The remote isn't on an episode (focused at $card, Season 1 at $chip)")
        val tops = intoTheMenuAndBack("Season 1")
        shot("42-episode-back-from-menu")
        check(tops.distinct().size == 1 && tops[0] != null, "The page moved going to the menu and back from an episode (Season 1 at ${tops.distinct()})")
        assertTrue(problems.joinToString("; "), problems.isEmpty())
    }
}
