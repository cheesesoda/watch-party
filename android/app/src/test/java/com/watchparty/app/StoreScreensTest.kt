package com.watchparty.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Pictures for the app stores (1920×1080, what a TV shows), with a library of the Blender Foundation's open movies
 * (Big Buck Bunny, Sintel, Tears of Steel, CC BY) instead of anyone's real library, so no other studio's artwork is in
 * them. Posters are TMDB's; backdrops and the video behind the player are frames from the films. They land in
 * build/tv-screens as store-*.png, beside the TV screen tests' pictures.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-land-television-xhdpi")
class StoreScreensTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()
    private lateinit var focus: FocusManager
    private val server = MockWebServer()
    private val out = File("build/tv-screens").apply { mkdirs() }

    private fun resource(name: String): ByteArray = javaClass.getResourceAsStream("/store/$name")!!.use { it.readBytes() }

    private fun movie(id: String, title: String, year: Int, minutes: Double, overview: String, art: String, genres: List<String>, rating: Double, addedAt: Long) =
        MediaItem(
            id = id, title = title, relPath = "Movies/$title ($year).mp4", folder = "Movies", size = 400_000_000, addedAt = addedAt, year = year,
            duration = minutes * 60,
            meta = MediaMeta(
                tmdbId = addedAt, title = title, year = year, overview = overview, posterPath = "/poster-$art.jpg",
                backdropPath = "/backdrop-$art.jpg", rating = rating, genres = genres,
            ),
        )

    private val sintel = movie(
        "sintel", "Sintel", 2010, 14.8,
        "A wandering warrior finds an unlikely friend in a young dragon. When the dragon is snatched away, she sets out on a relentless quest to get it back.",
        "sintel", listOf("Animation", "Fantasy"), 7.0, 3000,
    )
    private val bunny = movie(
        "bbb", "Big Buck Bunny", 2008, 9.9,
        "A gentle giant of a rabbit meets three rodents who make a sport of bullying the forest's creatures, and decides it's time to teach them a lesson.",
        "bbb", listOf("Animation", "Comedy"), 6.5, 2000,
    )
    private val tears = movie(
        "tos", "Tears of Steel", 2012, 12.2,
        "In a future Amsterdam, a group of warriors and scientists gather at the Oude Kerk to restage a moment from the past and save the world from destructive robots.",
        "tos", listOf("Science Fiction"), 6.1, 4000,
    )
    private val items = listOf(tears, sintel, bunny)

    private val spots = listOf(Spot("s1", sintel, 9 * 60.0 + 12, next = listOf(tears), savedAt = 5000))

    private val parties = listOf(
        RoomSummary(
            id = "movies",
            media = tears,
            members = listOf(Member("m1", "Jake", device = "tv"), Member("m2", "Sam", device = "phone"), Member("m3", "Riley", device = "web")),
            playback = RoomPlayback(position = 5 * 60.0 + 20, paused = false, duration = tears.duration),
        ),
    )

    @org.junit.Before
    fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                return when {
                    path.startsWith("/api/library") -> json("""{"items":${Protocol.json.encodeToString(items)}}""")
                    path.startsWith("/api/rooms") && request.method == "POST" -> json("""{"room":{"id":"abc123","solo":true}}""")
                    path.startsWith("/api/rooms") -> json("""{"rooms":${Protocol.json.encodeToString(parties)}}""")
                    path.startsWith("/api/spots/") -> json("{}")
                    path.startsWith("/api/spots") -> json("""{"spots":${Protocol.json.encodeToString(spots)}}""")
                    // /api/images/<size>/poster-sintel.jpg and the like.
                    path.startsWith("/api/images/") -> runCatching { resource(path.substringAfterLast('/')) }.getOrNull()
                        ?.let { MockResponse().setHeader("Content-Type", "image/jpeg").setBody(Buffer().write(it)) }
                        ?: MockResponse().setResponseCode(404)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After
    fun stop() = server.shutdown()

    private fun prefs() = Prefs(ApplicationProvider.getApplicationContext()).apply {
        serverUrl = server.url("/").toString().trimEnd('/')
        token = "test"
        name = "Jake"
        markSignedIn(true)
    }

    /** The TV home, against the pretend server, with the remote's focus working. */
    private fun dashboard() {
        val prefs = prefs()
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            focus = LocalFocusManager.current
            val inputMode = LocalInputModeManager.current
            SideEffect { @OptIn(ExperimentalComposeUiApi::class) inputMode.requestInputMode(InputMode.Keyboard) }
            PopcornTheme {
                Box(Modifier.fillMaxSize().background(Bg)) { Dashboard(prefs, onSignedOut = {}, forceTv = true) }
            }
        }
        rule.runOnIdle { rule.activity.window.decorView.dispatchWindowFocusChanged(true) }
        settle { rule.onAllNodesWithText("Pick up where you left off").fetchSemanticsNodes().isNotEmpty() }
        // Let the posters and backdrops arrive.
        settle(3_000) { false }
    }

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

    private fun shot(name: String) {
        rule.mainClock.advanceTimeBy(600)
        rule.waitForIdle()
        val view = rule.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        rule.runOnIdle { view.draw(Canvas(bitmap)) }
        File(out, "store-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun press(direction: FocusDirection, times: Int = 1) = repeat(times) {
        rule.runOnIdle { focus.moveFocus(direction) }
        settle(400) { false }
    }

    private fun ok() {
        rule.onNode(isFocused()).performSemanticsAction(SemanticsActions.OnClick)
        settle(1_500) { false }
    }

    @Test
    fun home() {
        dashboard()
        shot("1-home")
        press(FocusDirection.Down)
        shot("2-home-pick-up")
        press(FocusDirection.Left)
        shot("3-menu")
    }

    @Test
    fun moviePage() {
        dashboard()
        // Movies from the menu, then the first movie.
        press(FocusDirection.Left)
        press(FocusDirection.Up, 8)
        press(FocusDirection.Down, 2)
        ok()
        press(FocusDirection.Right)
        press(FocusDirection.Down)
        shot("4-movies")
        ok()
        settle(2_000) { false }
        shot("5-movie-page")
    }

    /** A frame of the film behind the player's overlays. */
    @androidx.compose.runtime.Composable
    private fun Video(name: String) {
        val bytes = resource(name)
        Image(BitmapFactory.decodeByteArray(bytes, 0, bytes.size).asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
    }

    @Test
    fun skipIntro() {
        val focusKey = mutableStateOf(0)
        rule.setContent {
            val inputMode = LocalInputModeManager.current
            SideEffect { @OptIn(ExperimentalComposeUiApi::class) inputMode.requestInputMode(InputMode.Keyboard) }
            PopcornTheme {
                Box(Modifier.fillMaxSize()) {
                    Video("video-bbb.jpg")
                    Box(Modifier.align(Alignment.BottomEnd).padding(48.dp)) {
                        SkipPartButton(kind = "intro", tv = true, focusKey = focusKey.value) {}
                    }
                }
            }
        }
        rule.waitForIdle()
        focusKey.value = 1
        rule.waitForIdle()
        shot("6-skip-intro")
    }

    @Test
    fun upNext() {
        rule.mainClock.autoAdvance = false
        val now = 1_000_000L
        val api = Api(server.url("/").toString().trimEnd('/'), "test")
        rule.setContent {
            PopcornTheme {
                Box(Modifier.fillMaxSize()) {
                    Video("video-sintel.jpg")
                    Box(Modifier.align(Alignment.BottomEnd).padding(48.dp)) {
                        NextCard(api, tv = true, item = tears, at = now + 6_000, total = 10_000, serverNow = { now }, onPlayNow = {}, onStay = {})
                    }
                }
            }
        }
        // The poster comes from the pretend server.
        val until = System.currentTimeMillis() + 3_000
        while (System.currentTimeMillis() < until) {
            Thread.sleep(50)
            rule.mainClock.advanceTimeBy(16)
            rule.waitForIdle()
        }
        shot("7-up-next")
    }
}
