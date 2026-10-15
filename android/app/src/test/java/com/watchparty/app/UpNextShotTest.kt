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

/** The TV's Up next list over a stand-in for the video: names first, the show and episode under them, no place numbers. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-land-television-xhdpi")
class UpNextShotTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private fun ep(n: Int, name: String) = MediaItem(
        id = "e$n", title = "Severance S1E$n", relPath = "TV/Severance/S1/E$n.mkv", folder = "TV/Severance", size = 1, addedAt = 1, duration = 3100.0,
        episode = EpisodeInfo("Severance", 1, n, name),
        meta = MediaMeta(tmdbId = n.toLong(), title = name, show = "Severance"),
    )

    @Test
    fun list() {
        val items = listOf(ep(1, "Good News About Hell"), ep(2, "Half Loop"), ep(3, "In Perpetuity"), ep(4, "The You You Are"))
        rule.setContent {
            PopcornTheme {
                Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFF8E6A4A), Color(0xFF2A1A12))))) {
                    UpNext(
                        UpNextScreen(Api("http://localhost:1", ""), tv = true, code = "ABC123", edit = {}, position = { 600.0 }, onPlay = {}, onAddVideos = {}, onClose = {}),
                        Queue(items = items, at = 0),
                        items[0],
                    )
                }
            }
        }
        rule.waitForIdle()
        assertTrue("the second episode's name is the row's title", rule.onAllNodesWithText("Half Loop").fetchSemanticsNodes().isNotEmpty())
        assertTrue("the show and episode sit under it", rule.onAllNodesWithText("Severance S1 E2", substring = true).fetchSemanticsNodes().isNotEmpty())
        assertTrue("no place numbers", rule.onAllNodesWithText("2").fetchSemanticsNodes().isEmpty())
        val view = rule.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        rule.runOnIdle { view.draw(Canvas(bitmap)) }
        File("build/tv-screens").apply { mkdirs() }.let { File(it, "42-up-next-list.png") }.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
