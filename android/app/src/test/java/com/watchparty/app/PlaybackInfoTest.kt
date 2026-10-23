package com.watchparty.app

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.net.InetAddress

/** Settings > Playback info: what the panel says, and the panel over a stand-in for the video (beside the TV screens). */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-land-television-xhdpi")
class PlaybackInfoTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val stats = PlaybackStats(
        playing = "Original file",
        video = videoLine(1920, 1080, "video/avc", 8_400_000),
        audio = audioLine("en", "audio/mp4a-latm", 6),
        route = "Internet (Funnel)",
        downloadBps = 24_000_000,
        bufferedMs = 38_400,
        waits = 2,
        waitedMs = 9_200,
        droppedFrames = 3,
    )

    @Test
    fun saysHowTheVideoStreams() {
        assertEquals("1920×1080 · H.264 · 8.4 Mbps", stats.video)
        assertEquals("English · AAC 5.1", stats.audio)
        assertEquals("850 kbps", bitrate(850_000))
        assertEquals("HEVC", codecName("video/hevc"))
        assertNull(videoLine(0, 0, null, null))
        assertEquals("AAC stereo", audioLine("und", "audio/mp4a-latm", 2))
        val rows = playbackRows(stats).associate { it.label to it }
        assertEquals("38 s", rows["Buffered ahead"]!!.value)
        assertEquals("2 · 9 s in all", rows["Waits (last 5 min)"]!!.value)
        assertTrue(rows["Waits (last 5 min)"]!!.warn)
        assertEquals("None", playbackRows(stats.copy(waits = 0, waitedMs = 0)).first { it.label.startsWith("Waits") }.value)
        assertEquals("Measuring…", playbackRows(stats.copy(downloadBps = null)).first { it.label == "Download speed" }.value)
    }

    @Test
    fun tellsTheRoute() {
        val ip = { a: String -> InetAddress.getByName(a) }
        assertEquals("Tailscale (direct)", routeOf("pc.tail1234.ts.net", listOf(ip("100.101.102.103"))))
        assertEquals("Internet (Funnel)", routeOf("pc.tail1234.ts.net", listOf(ip("34.120.1.2"))))
        assertEquals("Home network", routeOf("192.168.1.5", listOf(ip("192.168.1.5"))))
        assertEquals("Internet", routeOf("app.tv.chzsda.com", listOf(ip("66.33.22.11"))))
        // 100.128.x is outside Tailscale's range.
        assertEquals("Internet", routeOf("example.com", listOf(ip("100.128.0.1"))))
    }

    @Test
    fun countsWaitsOfTheLastFiveMinutes() {
        val log = WaitLog()
        log.add(1_000, 3_000)
        log.add(200_000, 6_000)
        assertEquals(2 to 9_000L, log.recent(250_000))
        assertEquals(1 to 6_000L, log.recent(302_000))
    }

    private fun shot(tv: Boolean, name: String) {
        rule.setContent {
            PopcornTheme {
                Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFF8E6A4A), Color(0xFF2A1A12))))) {
                    Box(Modifier.align(Alignment.TopEnd).padding(top = if (tv) 28.dp else 72.dp, end = if (tv) 32.dp else 16.dp)) {
                        PlaybackInfoPanel(playbackRows(stats), tv)
                    }
                }
            }
        }
        rule.waitForIdle()
        assertTrue(rule.onAllNodesWithText("PLAYBACK INFO").fetchSemanticsNodes().isNotEmpty())
        val view = rule.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        rule.runOnIdle { view.draw(Canvas(bitmap)) }
        File("build/tv-screens").apply { mkdirs() }.let { File(it, "$name.png") }.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun tvPanel() = shot(true, "60-playback-info-tv")

    @Test
    @Config(qualifiers = "w915dp-h412dp-land-xxhdpi")
    fun phonePanel() = shot(false, "61-playback-info-phone")
}
