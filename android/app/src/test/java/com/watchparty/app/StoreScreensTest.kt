package com.watchparty.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
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
import java.io.File

/**
 * A library of the Blender Foundation's open movies (Big Buck Bunny, Sintel, Tears of Steel, CC BY) for the app store
 * pictures, instead of anyone's real library, so no other studio's artwork is in them. Posters are TMDB's; backdrops
 * and the video behind the player are frames from the films (test resources under store/).
 */
private object StoreLibrary {
    fun resource(name: String): ByteArray = StoreLibrary::class.java.getResourceAsStream("/store/$name")!!.use { it.readBytes() }

    private fun movie(id: String, title: String, year: Int, minutes: Double, overview: String, genres: List<String>, rating: Double, addedAt: Long) =
        MediaItem(
            id = id, title = title, relPath = "Movies/$title ($year).mp4", folder = "Movies", size = 400_000_000, addedAt = addedAt, year = year,
            duration = minutes * 60,
            meta = MediaMeta(
                tmdbId = addedAt, title = title, year = year, overview = overview, posterPath = "/poster-$id.jpg",
                backdropPath = "/backdrop-$id.jpg", rating = rating, genres = genres,
            ),
        )

    val sintel = movie(
        "sintel", "Sintel", 2010, 14.8,
        "A wandering warrior finds an unlikely friend in a young dragon. When the dragon is snatched away, she sets out on a relentless quest to get it back.",
        listOf("Animation", "Fantasy"), 7.0, 3000,
    )
    val bunny = movie(
        "bbb", "Big Buck Bunny", 2008, 9.9,
        "A gentle giant of a rabbit meets three rodents who make a sport of bullying the forest's creatures, and decides it's time to teach them a lesson.",
        listOf("Animation", "Comedy"), 6.5, 2000,
    )
    val tears = movie(
        "tos", "Tears of Steel", 2012, 12.2,
        "In a future Amsterdam, a group of warriors and scientists gather at the Oude Kerk to restage a moment from the past and save the world from destructive robots.",
        listOf("Science Fiction"), 6.1, 4000,
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

    val dispatcher = object : Dispatcher() {
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

    /**
     * "It's a party" over the player, as Invite friends shows it (RoomActivity.makeParty, a classic dialog in its own
     * window, which a screenshot of the activity doesn't include): drawn here the same way, in the same colors and
     * sizes, with the same words, code and QR (an invite link to the built-in server's join page).
     */
    @Composable
    fun Invite(tv: Boolean, video: String) {
        val onSurface = Color(0xFFEEEAF3)
        val variant = Color(0xFFB0A6BF)
        val accent = Color(0xFFE09A62)
        val code = "FX7Q2K"
        Box(Modifier.fillMaxSize()) {
            Video(video)
            Box(Modifier.fillMaxSize().background(Color(0x99000000)))
            Column(
                Modifier.align(Alignment.Center).width(if (tv) 420.dp else 360.dp).clip(RoundedCornerShape(28.dp)).background(Color(0xFF31283E))
                    .padding(start = 24.dp, end = 24.dp, top = 24.dp, bottom = 16.dp),
            ) {
                Text("It's a party", color = onSurface, fontSize = 24.sp)
                Spacer(Modifier.height(12.dp))
                Text("Friends join with this code, or by scanning the code with their phone.", color = variant, fontSize = 14.sp, lineHeight = 20.sp)
                Spacer(Modifier.height(4.dp))
                Text(code, color = onSurface, fontSize = 36.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.12.em, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                Box(Modifier.fillMaxWidth().padding(top = 12.dp), contentAlignment = Alignment.Center) {
                    Box(Modifier.size(if (tv) 180.dp else 200.dp).clip(RoundedCornerShape(12.dp)).background(Color.White).padding(10.dp)) {
                        Image(qrBitmap("https://tv.chzsda.com/join/" + code.lowercase()), null, Modifier.fillMaxSize())
                    }
                }
                Spacer(Modifier.height(20.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                    if (!tv) {
                        Text("Copy invite link", color = accent, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp))
                        Spacer(Modifier.weight(1f))
                    }
                    // On a TV the remote starts on Done: a white pill, a little larger.
                    val pill = if (tv) Modifier.scale(1.06f).clip(RoundedCornerShape(20.dp)).background(Color(0xFFF2EEF7)) else Modifier
                    Text("Done", color = if (tv) Color(0xFF18131F) else accent, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                        modifier = pill.padding(horizontal = 16.dp, vertical = 10.dp))
                }
            }
        }
    }

    /** A frame of the film behind the player's overlays. */
    @Composable
    fun Video(name: String) {
        val bytes = resource(name)
        Image(BitmapFactory.decodeByteArray(bytes, 0, bytes.size).asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
    }
}

/** Runs the app (network threads, main looper, a moving clock) until [done] or [ms] pass. */
private fun AndroidComposeTestRule<ActivityScenarioRule<ComponentActivity>, ComponentActivity>.settle(ms: Long = 15_000, done: () -> Boolean) {
    val until = System.currentTimeMillis() + ms
    while (System.currentTimeMillis() < until) {
        Thread.sleep(50)
        mainClock.advanceTimeBy(50)
        waitForIdle()
        if (done()) return
    }
    if (ms >= 5_000) throw AssertionError("Gave up waiting after $ms ms")
}

/** The whole window as store-[name].png in build/tv-screens, beside the TV screen tests' pictures. */
private fun AndroidComposeTestRule<ActivityScenarioRule<ComponentActivity>, ComponentActivity>.storeShot(name: String) {
    mainClock.advanceTimeBy(600)
    waitForIdle()
    val view = activity.window.decorView
    val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
    runOnIdle { view.draw(Canvas(bitmap)) }
    File(File("build/tv-screens").apply { mkdirs() }, "store-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
}

private fun signedIn(server: MockWebServer) = Prefs(ApplicationProvider.getApplicationContext()).apply {
    serverUrl = server.url("/").toString().trimEnd('/')
    token = "test"
    name = "Jake"
    markSignedIn(true)
}

/** The store pictures for TVs (Fire TV, Android TV): 1920×1080. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-land-television-xhdpi")
class StoreScreensTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()
    private lateinit var focus: FocusManager
    private val server = MockWebServer()

    @Before
    fun start() {
        server.dispatcher = StoreLibrary.dispatcher
        server.start()
    }

    @After
    fun stop() = server.shutdown()

    /** The TV home, with the remote's focus working. */
    private fun dashboard() {
        val prefs = signedIn(server)
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
        rule.settle { rule.onAllNodesWithText("Pick up where you left off").fetchSemanticsNodes().isNotEmpty() }
        // Let the posters and backdrops arrive.
        rule.settle(3_000) { false }
    }

    private fun press(direction: FocusDirection, times: Int = 1) = repeat(times) {
        rule.runOnIdle { focus.moveFocus(direction) }
        rule.settle(400) { false }
    }

    private fun ok() {
        rule.onNode(isFocused()).performSemanticsAction(SemanticsActions.OnClick)
        rule.settle(1_500) { false }
    }

    @Test
    fun home() {
        dashboard()
        rule.storeShot("1-home")
        press(FocusDirection.Down)
        rule.storeShot("2-home-pick-up")
        press(FocusDirection.Left)
        rule.storeShot("3-menu")
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
        rule.storeShot("4-movies")
        ok()
        rule.settle(2_000) { false }
        rule.storeShot("5-movie-page")
    }

    @Test
    fun skipIntro() {
        val focusKey = mutableStateOf(0)
        rule.setContent {
            val inputMode = LocalInputModeManager.current
            SideEffect { @OptIn(ExperimentalComposeUiApi::class) inputMode.requestInputMode(InputMode.Keyboard) }
            PopcornTheme {
                Box(Modifier.fillMaxSize()) {
                    StoreLibrary.Video("video-bbb.jpg")
                    Box(Modifier.align(Alignment.BottomEnd).padding(48.dp)) {
                        SkipPartButton(kind = "intro", tv = true, focusKey = focusKey.value) {}
                    }
                }
            }
        }
        rule.waitForIdle()
        focusKey.value = 1
        rule.waitForIdle()
        rule.storeShot("6-skip-intro")
    }

    @Test
    fun upNext() {
        rule.mainClock.autoAdvance = false
        val now = 1_000_000L
        val api = Api(server.url("/").toString().trimEnd('/'), "test")
        rule.setContent {
            PopcornTheme {
                Box(Modifier.fillMaxSize()) {
                    StoreLibrary.Video("video-sintel.jpg")
                    Box(Modifier.align(Alignment.BottomEnd).padding(48.dp)) {
                        NextCard(api, tv = true, item = StoreLibrary.tears, at = now + 6_000, total = 10_000, serverNow = { now }, onPlayNow = {}, onStay = {})
                    }
                }
            }
        }
        // The poster comes from the pretend server.
        rule.settle(3_000) { false }
        rule.storeShot("7-up-next")
    }

    @Test
    fun invite() {
        rule.setContent { PopcornTheme { StoreLibrary.Invite(tv = true, video = "video-tos.jpg") } }
        rule.waitForIdle()
        rule.storeShot("8-invite")
    }
}

/**
 * The store pictures for tablets (Fire tablets): the phone layout at 1920×1200 landscape, and Home at 1200×1920
 * portrait.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w960dp-h600dp-land-xhdpi")
class StoreTabletScreensTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()

    @Before
    fun start() {
        server.dispatcher = StoreLibrary.dispatcher
        server.start()
    }

    @After
    fun stop() = server.shutdown()

    private fun dashboard() {
        val prefs = signedIn(server)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            PopcornTheme {
                Box(Modifier.fillMaxSize().background(Bg)) { Dashboard(prefs, onSignedOut = {}) }
            }
        }
        rule.runOnIdle { rule.activity.window.decorView.dispatchWindowFocusChanged(true) }
        rule.settle { listOf("Pick up where you left off", "Recently added").any { rule.onAllNodesWithText(it).fetchSemanticsNodes().isNotEmpty() } }
        rule.settle(3_000) { false }
    }

    private fun tap(text: String) {
        rule.onAllNodes(hasText(text) and hasClickAction())[0].performSemanticsAction(SemanticsActions.OnClick)
        rule.settle(1_500) { false }
    }

    /** A poster card: its click is on the poster, just above the title. */
    private fun tapPoster(title: String) {
        val label = rule.onAllNodesWithText(title)[0].fetchSemanticsNode().boundsInRoot
        val x = label.center.x
        val y = label.top - 40f
        val nodes = rule.onAllNodes(hasClickAction()).fetchSemanticsNodes()
        val i = nodes.indexOfFirst { it.boundsInRoot.contains(androidx.compose.ui.geometry.Offset(x, y)) }
        assertTrue("No poster above $title", i >= 0)
        rule.onAllNodes(hasClickAction())[i].performSemanticsAction(SemanticsActions.OnClick)
        rule.settle(2_000) { false }
    }

    @Test
    fun home() {
        dashboard()
        rule.storeShot("tablet-1-home")
    }

    @Test
    @Config(qualifiers = "w600dp-h960dp-port-xhdpi")
    fun homePortrait() {
        dashboard()
        rule.storeShot("tablet-2-home-portrait")
    }

    @Test
    fun moviePage() {
        dashboard()
        tap("Movies")
        rule.storeShot("tablet-3-movies")
        tapPoster("Sintel")
        rule.storeShot("tablet-4-movie-page")
    }

    @Test
    fun skipIntro() {
        rule.setContent {
            PopcornTheme {
                Box(Modifier.fillMaxSize()) {
                    StoreLibrary.Video("video-bbb.jpg")
                    Box(Modifier.align(Alignment.BottomEnd).padding(32.dp)) {
                        SkipPartButton(kind = "intro", tv = false, focusKey = 0) {}
                    }
                }
            }
        }
        rule.waitForIdle()
        rule.storeShot("tablet-5-skip-intro")
    }

    @Test
    fun upNext() {
        rule.mainClock.autoAdvance = false
        val now = 1_000_000L
        val api = Api(server.url("/").toString().trimEnd('/'), "test")
        rule.setContent {
            PopcornTheme {
                Box(Modifier.fillMaxSize()) {
                    StoreLibrary.Video("video-sintel.jpg")
                    Box(Modifier.align(Alignment.BottomEnd).padding(32.dp)) {
                        NextCard(api, tv = false, item = StoreLibrary.tears, at = now + 6_000, total = 10_000, serverNow = { now }, onPlayNow = {}, onStay = {})
                    }
                }
            }
        }
        rule.settle(3_000) { false }
        rule.storeShot("tablet-6-up-next")
    }

    @Test
    fun invite() {
        rule.setContent { PopcornTheme { StoreLibrary.Invite(tv = false, video = "video-tos.jpg") } }
        rule.waitForIdle()
        rule.storeShot("tablet-7-invite")
    }
}
