package com.watchparty.app

import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Up from the TV's controls reaches Skip recap / the Up next card while the controls show (paused, or just after a
 * press). Android's own focus search never found them: Skip intro is only moved up above the seek bar
 * (translationY), and focus search goes by where views are laid out.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-land-television-xhdpi")
class TvSkipFocusTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Before
    fun noTouch() {
        // A TV has no touch screen; in touch mode Android won't move focus around.
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
    }

    private fun up(controlsShown: Boolean = true, onTopRow: Boolean = true, panelOpen: Boolean = false, skip: Boolean = false, next: Boolean = false) =
        upFromControlsGoesTo(KeyEvent.KEYCODE_DPAD_UP, controlsShown, onTopRow, panelOpen, skip, next)

    @Test
    fun upFromTheSeekBarGoesToTheCorner() {
        assertEquals(Corner.Skip, up(skip = true))
        assertEquals(Corner.NextCard, up(next = true))
        // Nothing there, the controls hidden (the press brings them up instead), a button row, or chat / Up next open.
        assertNull(up())
        assertNull(up(controlsShown = false, skip = true))
        assertNull(up(onTopRow = false, skip = true))
        assertNull(up(panelOpen = true, skip = true))
        // Only Up.
        assertNull(upFromControlsGoesTo(KeyEvent.KEYCODE_DPAD_LEFT, true, true, false, true, false))
        assertNull(upFromControlsGoesTo(KeyEvent.KEYCODE_DPAD_DOWN, true, true, false, true, false))
    }

    /** The player's layout in small: a focusable stand-in for the seek bar, and the corner button moved up over it. */
    private fun player(content: @Composable () -> Unit): View {
        lateinit var seekBar: View
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread {
            val activity = rule.activity
            seekBar = View(activity).apply { isFocusable = true; isFocusableInTouchMode = true }
            val root = FrameLayout(activity)
            root.addView(seekBar, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, 100, Gravity.BOTTOM).apply { bottomMargin = 200 })
            root.addView(
                ComposeView(activity).apply {
                    // As RoomActivity has it: no gray box around the rounded shape.
                    defaultFocusHighlightEnabled = false
                    translationY = -300f
                    setContent {
                        // A TV remote's D-pad: keyboard mode, where buttons take focus.
                        val inputMode = LocalInputModeManager.current
                        SideEffect { @OptIn(ExperimentalComposeUiApi::class) inputMode.requestInputMode(InputMode.Keyboard) }
                        PopcornTheme { Box(Modifier.padding(24.dp)) { content() } }
                    }
                },
                FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END),
            )
            activity.setContentView(root)
        }
        settle()
        return seekBar
    }

    private fun settle() {
        rule.mainClock.advanceTimeBy(500)
        rule.waitForIdle()
    }

    /** The controls come up (pausing does that) and the remote is on the seek bar. */
    private fun controlsUp(seekBar: View) {
        rule.runOnUiThread { assertTrue(seekBar.requestFocus()) }
        settle()
        assertTrue(seekBar.isFocused)
    }

    private fun press(keyCode: Int) = rule.runOnUiThread {
        rule.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
        rule.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, keyCode))
    }

    @Test
    fun pausedUpReachesSkipRecapAndOkSkips() {
        val focusKey = mutableStateOf(0)
        var skipped = 0
        val seekBar = player { SkipPartButton(kind = "recap", tv = true, focusKey = focusKey.value) { skipped++ } }
        // Paused: the controls show, the remote on the seek bar. Up does what RoomActivity does with it.
        controlsUp(seekBar)
        assertEquals(Corner.Skip, up(skip = true))
        focusKey.value++
        settle()
        rule.onAllNodesWithText("Skip recap")[0].assertIsFocused()
        assertFalse(seekBar.isFocused)
        // Resumed, with the controls up over it again: Up still gets there, and OK skips.
        controlsUp(seekBar)
        focusKey.value++
        settle()
        rule.onAllNodesWithText("Skip recap")[0].assertIsFocused()
        assertFalse(seekBar.isFocused)
        press(KeyEvent.KEYCODE_DPAD_CENTER)
        settle()
        assertEquals(1, skipped)
    }

    @Test
    fun pausedUpReachesUpNextsPlayNow() {
        val focusKey = mutableStateOf(0)
        var played = 0
        val item = MediaItem(
            id = "e2", title = "Severance S1E2", relPath = "TV/Severance/S1/E2.mkv", folder = "TV/Severance", size = 1, addedAt = 1,
            episode = EpisodeInfo("Severance", 1, 2),
            meta = MediaMeta(tmdbId = 2, title = "Goodbye, Mrs. Selvig", show = "Severance"),
        )
        val now = 1_000_000L
        val seekBar = player {
            NextCard(
                Api("http://localhost:1", ""), tv = true, item = item, at = now + 8_000, total = 10_000, serverNow = { now },
                onPlayNow = { played++ }, onStay = {}, focusKey = focusKey.value,
            )
        }
        // Pausing brought the controls up and took the remote off the card.
        controlsUp(seekBar)
        assertEquals(Corner.NextCard, up(next = true))
        focusKey.value++
        settle()
        rule.onAllNodesWithText("Play now")[0].assertIsFocused()
        assertFalse(seekBar.isFocused)
        press(KeyEvent.KEYCODE_DPAD_CENTER)
        settle()
        assertEquals(1, played)
    }
}
