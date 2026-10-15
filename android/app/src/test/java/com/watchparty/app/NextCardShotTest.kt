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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** The Up next card over a stand-in for the video, for the host and for a guest (screenshots beside the TV ones). */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-land-television-xhdpi")
class NextCardShotTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val item = MediaItem(
        id = "e2", title = "Severance S1E2", relPath = "TV/Severance/S1/E2.mkv", folder = "TV/Severance", size = 1, addedAt = 1,
        episode = EpisodeInfo("Severance", 1, 2),
        meta = MediaMeta(tmdbId = 2, title = "Goodbye, Mrs. Selvig", show = "Severance"),
    )

    private fun card(host: Boolean, name: String) {
        rule.mainClock.autoAdvance = false
        val now = 1_000_000L
        rule.setContent {
            PopcornTheme {
                Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFF8E6A4A), Color(0xFF2A1A12))))) {
                    Box(Modifier.align(Alignment.BottomEnd).padding(48.dp)) {
                        NextCard(Api("http://localhost:1", ""), tv = true, item = item, at = now + 4_000, total = 10_000, serverNow = { now },
                            onPlayNow = if (host) ({}) else null, onStay = if (host) ({}) else null)
                    }
                }
            }
        }
        rule.mainClock.advanceTimeBy(500)
        rule.waitForIdle()
        assertTrue(rule.onAllNodesWithText("UP NEXT · IN 4").fetchSemanticsNodes().isNotEmpty())
        if (host) {
            // The countdown bar must not stretch Play now: it stays about as wide as Stay here (it has an icon too).
            val density = rule.activity.resources.displayMetrics.density
            val play = rule.onAllNodesWithText("Play now")[0].fetchSemanticsNode().boundsInRoot.width / density
            val stay = rule.onAllNodesWithText("Stay here")[0].fetchSemanticsNode().boundsInRoot.width / density
            assertTrue("Play now is $play dp wide next to Stay here's $stay dp", play - stay < 40f)
        }
        val view = rule.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        rule.runOnIdle { view.draw(Canvas(bitmap)) }
        File("build/tv-screens").apply { mkdirs() }.let { File(it, "$name.png") }.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun host() = card(true, "40-up-next-host")

    @Test
    fun guest() = card(false, "41-up-next-guest")
}
