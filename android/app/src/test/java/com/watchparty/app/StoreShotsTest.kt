package com.watchparty.app

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.media3.common.MediaItem as ExoItem
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Store screenshots (Amazon Appstore, Play): the TV app at 1920 x 1080 with the demo library's films and stills
 * from them. Only runs where the stills are, in src/test/resources/store-art (films.tsv: title, year, still prefix,
 * overview). The pictures land in build/tv-screens/store-*.png.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-land-television-xhdpi")
class StoreShotsTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()
    private lateinit var focus: FocusManager
    private val server = MockWebServer()
    private val out = File("build/tv-screens").apply { mkdirs() }
    private val art = File("src/test/resources/store-art")

    private data class Film(val title: String, val year: Int, val prefix: String, val overview: String, val minutes: Int)

    private val films by lazy {
        File(art, "films.tsv").readLines().filter { it.isNotBlank() && !it.startsWith("#") }.map { line ->
            val (title, year, prefix, minutes, overview) = line.split('\t')
            Film(title, year.toInt(), prefix, overview, minutes.toInt())
        }
    }

    private fun still(film: Int, n: Int): Bitmap = BitmapFactory.decodeFile(File(art, "${films[film].prefix}-$n.jpg").path)

    private fun jpeg(bitmap: Bitmap): Buffer =
        Buffer().write(ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 92, it) }.toByteArray())

    /** A poster from a still: the middle of it, 2:3. */
    private fun poster(film: Int): Bitmap {
        File(art, "poster-${films[film].prefix}.jpg").takeIf { it.exists() }?.let { return BitmapFactory.decodeFile(it.path) }
        val s = still(film, 2)
        val w = s.height * 2 / 3
        return Bitmap.createBitmap(s, (s.width - w) / 2, 0, w, s.height)
    }

    private val items by lazy {
        films.mapIndexed { i, f ->
            MediaItem(
                id = "m$i", title = f.title, relPath = "Movies/${f.title} (${f.year}).mkv", folder = "Movies", size = 1, addedAt = 1000L - i,
                year = f.year, duration = f.minutes * 60.0,
                meta = MediaMeta(tmdbId = i + 1L, title = f.title, year = f.year, overview = f.overview, posterPath = "/p$i.jpg", backdropPath = "/b$i.jpg", genres = listOf("Animation")),
            )
        }
    }

    private val members = listOf(
        Member("a", "Jake", device = "tv"), Member("b", "Sam", device = "phone"), Member("c", "Riley", device = "web"),
    )

    private fun dispatcher(socket: WebSocketListener? = null) = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.path.orEmpty()
            fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            val name = path.substringAfterLast('/').substringBefore('?')
            return when {
                path.startsWith("/ws") && socket != null -> MockResponse().withWebSocketUpgrade(socket)
                path.startsWith("/api/library") -> json("""{"items":${Protocol.json.encodeToString(items)}}""")
                path.startsWith("/api/rooms") -> json(
                    """{"rooms":${Protocol.json.encodeToString(listOf(RoomSummary("party1", items.getOrNull(2) ?: items[0], members, RoomPlayback(1500.0, false, items[0].duration))))}}""",
                )
                path.startsWith("/api/spots") && path.endsWith("frame.jpg") -> MockResponse().setHeader("Content-Type", "image/jpeg").setBody(jpeg(still(1, 3)))
                path.startsWith("/api/spots") -> json("""{"spots":${Protocol.json.encodeToString(listOf(Spot("s1", items[1 % items.size], 420.0, savedAt = 2000)))}}""")
                path.startsWith("/api/images/") && name.startsWith("p") -> MockResponse().setHeader("Content-Type", "image/jpeg").setBody(jpeg(poster(name.drop(1).substringBefore('.').toInt())))
                path.startsWith("/api/images/") && name.startsWith("b") -> MockResponse().setHeader("Content-Type", "image/jpeg").setBody(jpeg(still(name.drop(1).substringBefore('.').toInt(), 1)))
                else -> json("{}")
            }
        }
    }

    @Before
    fun start() {
        assumeTrue("No store art in $art", File(art, "films.tsv").exists())
    }

    @After
    fun stop() {
        runCatching { server.shutdown() }
    }

    private fun signIn() {
        val prefs = Prefs(ApplicationProvider.getApplicationContext())
        prefs.serverUrl = server.url("/").toString().trimEnd('/')
        prefs.token = "test"
        prefs.name = "Jake"
        prefs.markSignedIn(true)
    }

    private fun settle(ms: Long) {
        val until = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < until) {
            Thread.sleep(50)
            rule.mainClock.advanceTimeBy(50)
            rule.waitForIdle()
        }
    }

    private fun save(view: View, name: String) {
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(out, "store-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun shot(name: String) {
        rule.mainClock.advanceTimeBy(600)
        rule.waitForIdle()
        rule.runOnIdle { save(rule.activity.window.decorView, name) }
    }

    private fun press(direction: FocusDirection, times: Int = 1) = repeat(times) {
        rule.runOnIdle { focus.moveFocus(direction) }
        settle(400)
    }

    private fun ok() {
        rule.onNode(isFocused()).performSemanticsAction(SemanticsActions.OnClick)
        settle(1_500)
    }

    /** A pretend player for the controls: a film paused partway, as the seek bar and times show it. */
    @OptIn(UnstableApi::class)
    private class StillPlayer(private val durationMs: Long, private val positionMs: Long) : SimpleBasePlayer(Looper.getMainLooper()) {
        override fun getState(): State = State.Builder()
            .setAvailableCommands(Player.Commands.Builder().addAllCommands().build())
            .setPlaylist(listOf(MediaItemData.Builder("film").setMediaItem(ExoItem.fromUri("http://localhost/film")).setDurationUs(durationMs * 1000).build()))
            .setPlaybackState(Player.STATE_READY)
            .setPlayWhenReady(true, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setContentPositionMs(positionMs)
            .build()

        override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> = Futures.immediateVoidFuture()
        override fun handleSetVideoOutput(videoOutput: Any): ListenableFuture<*> = Futures.immediateVoidFuture()
        override fun handleClearVideoOutput(videoOutput: Any?): ListenableFuture<*> = Futures.immediateVoidFuture()
    }

    private fun field(target: Any, name: String): Any? = RoomActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(target)

    /** The party's player over a still from the film: the controls up, then Skip intro, then Up next at the credits. */
    @OptIn(UnstableApi::class)
    @Test
    fun player() {
        val film = 1
        val media = items[film].copy(marks = SkipMarks(intro = TimeRange(0.0, 900.0)))
        val queue = Queue(items = items, at = film)
        val now = System.currentTimeMillis()
        server.dispatcher = dispatcher(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val welcome = buildJsonObject {
                    put("type", "welcome")
                    put("you", Protocol.json.encodeToJsonElement(Member.serializer(), members[0]))
                    put("roomId", "party1")
                    put("state", Protocol.json.encodeToJsonElement(PlaybackState.serializer(), PlaybackState(media.id, paused = false, position = 300.0, updatedAt = now)))
                    put("media", Protocol.json.encodeToJsonElement(MediaItem.serializer(), media))
                    put("members", Protocol.json.encodeToJsonElement(kotlinx.serialization.builtins.ListSerializer(Member.serializer()), members))
                    put("serverTime", now)
                    put("queue", Protocol.json.encodeToJsonElement(Queue.serializer(), queue))
                }
                webSocket.send(welcome.toString())
            }
        })
        server.start()
        signIn()
        // The player asks Android whether it's on a TV.
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        shadowOf(context.getSystemService(android.app.UiModeManager::class.java)).setCurrentModeType(android.content.res.Configuration.UI_MODE_TYPE_TELEVISION)
        val intent = Intent(ApplicationProvider.getApplicationContext(), RoomActivity::class.java)
            .putExtra(RoomActivity.EXTRA_ROOM, "k7qm2x").putExtra(RoomActivity.EXTRA_HOST, true)
        ActivityScenario.launch<RoomActivity>(intent).use { scenario ->
            fun idle(ms: Long) {
                val until = System.currentTimeMillis() + ms
                while (System.currentTimeMillis() < until) {
                    Thread.sleep(50)
                    shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(50))
                }
            }
            idle(3_000)
            scenario.onActivity { activity ->
                val playerView = field(activity, "playerView") as PlayerView
                // The film's picture where the video would be.
                val content = activity.findViewById<ViewGroup>(android.R.id.content)
                content.addView(ImageView(activity).apply { scaleType = ImageView.ScaleType.CENTER_CROP; setImageBitmap(still(film, 2)) }, 0, FrameLayout.LayoutParams(-1, -1))
                content.setBackgroundColor(Color.BLACK)
                playerView.setShutterBackgroundColor(Color.TRANSPARENT)
                // Behind the controls, where the video would be (the activity's own black root covers anything further back).
                playerView.background = android.graphics.drawable.BitmapDrawable(activity.resources, still(film, 2))
                // The video's surface draws black here; the still stands in for it.
                playerView.findViewById<View>(androidx.media3.ui.R.id.exo_content_frame)?.visibility = View.INVISIBLE
                playerView.player = StillPlayer(((media.duration ?: 600.0) * 1000).toLong(), 300_000)
                playerView.controllerShowTimeoutMs = 0
                playerView.showController()
                activity.window.decorView.dispatchWindowFocusChanged(true)
                playerView.findViewById<View>(androidx.media3.ui.R.id.exo_play_pause)?.requestFocus()
            }
            idle(1_500)
            scenario.onActivity { save(it.window.decorView, "6-player") }

            // Invite friends: the party's code and the QR code friends scan, with the invite link on the host's domain.
            scenario.onActivity { activity ->
                (field(activity, "playerView") as PlayerView).hideController()
                Prefs(activity).serverUrl = BuildConfig.DEFAULT_SERVER
                RoomActivity::class.java.getDeclaredMethod("makeParty").apply { isAccessible = true }.invoke(activity)
            }
            idle(1_500)
            scenario.onActivity { activity ->
                val dialog = org.robolectric.shadows.ShadowDialog.getLatestDialog()
                val page = activity.window.decorView
                val bitmap = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bitmap)
                page.draw(canvas)
                canvas.drawColor(Color.argb((255 * (dialog.window?.attributes?.dimAmount ?: 0.6f)).toInt(), 0, 0, 0))
                val box = dialog.window!!.decorView
                if (box.width == 0) {
                    val most = (560 * activity.resources.displayMetrics.density).toInt()
                    box.measure(View.MeasureSpec.makeMeasureSpec(most, View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(page.height, View.MeasureSpec.AT_MOST))
                    box.layout(0, 0, box.measuredWidth, box.measuredHeight)
                }
                canvas.save()
                canvas.translate((page.width - box.width) / 2f, (page.height - box.height) / 2f)
                box.draw(canvas)
                canvas.restore()
                File(out, "store-9-invite.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                dialog.dismiss()
            }
            idle(500)

            scenario.onActivity { activity ->
                val playerView = field(activity, "playerView") as PlayerView
                playerView.hideController()
                RoomActivity::class.java.getDeclaredMethod("showSkip", Pair::class.java).apply { isAccessible = true }.invoke(activity, Pair("intro", 400.0))
            }
            idle(1_500)
            scenario.onActivity { save(it.window.decorView, "7-skip-intro") }
            // The controls up over it: Skip intro moves up to just above the seek bar.
            scenario.onActivity { activity ->
                val playerView = field(activity, "playerView") as PlayerView
                playerView.showController()
                playerView.findViewById<View>(androidx.media3.ui.R.id.exo_progress)?.requestFocus()
            }
            idle(1_500)
            scenario.onActivity { save(it.window.decorView, "7b-skip-with-controls") }
            scenario.onActivity { (field(it, "playerView") as PlayerView).hideController() }
            idle(500)

            scenario.onActivity { activity ->
                // Near the credits the server counts down to the next film; the card shows over the picture.
                val next = items[(film + 1) % items.size]
                RoomActivity::class.java.getDeclaredMethod("setQueue", Queue::class.java).apply { isAccessible = true }
                    .invoke(activity, queue.copy(advance = Queue.Advance(next.id, System.currentTimeMillis() + 8_000)))
            }
            idle(1_500)
            scenario.onActivity { save(it.window.decorView, "8-up-next") }
        }
    }
}
