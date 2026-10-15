package com.watchparty.app

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Before
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The TV's side menu with the remote: Right from it has to reach the page (a grid of posters, like Movies). */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-land-television-xhdpi")
class TvMenuFocusTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Before
    fun noTouch() {
        // A TV has no touch screen; in touch mode Android won't move focus around.
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
    }

    private fun windowFocus() = rule.runOnIdle { rule.activity.window.decorView.dispatchWindowFocusChanged(true) }
    private lateinit var focus: FocusManager

    /** What the remote's arrow keys do (key events don't reach the app under Robolectric). */
    private fun move(direction: FocusDirection) {
        rule.runOnIdle { focus.moveFocus(direction) }
        rule.waitForIdle()
    }

    private fun page(alone: Boolean, focused: (Int) -> Unit) = rule.setContent {
        focus = LocalFocusManager.current
            // Clickable things only take focus while a remote or keyboard is in use, not in touch mode.
            val inputMode = LocalInputModeManager.current
            androidx.compose.runtime.SideEffect { @OptIn(ExperimentalComposeUiApi::class) inputMode.requestInputMode(InputMode.Keyboard) }
        TvShell("movies", adding = false, alone = alone, setAlone = {}, onCode = {}, onRefresh = {}, onSettings = {}, go = {}) {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(118.dp),
                contentPadding = PaddingValues(start = 96.dp, end = 48.dp, top = 32.dp, bottom = 32.dp),
                horizontalArrangement = Arrangement.spacedBy(22.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                items(18) { i -> Box(Modifier.aspectRatio(2f / 3f).semantics { contentDescription = "Card $i" }.onFocusChanged { if (it.isFocused) focused(i) }.clickable {}) }
            }
        }
    }

    private fun rightReachesThePage(alone: Boolean) {
        var card = -1
        page(alone) { card = it }
        windowFocus()
        focusCard(0)
        // Left from the page opens the menu…
        move(FocusDirection.Left)
        assertTrue("Left from the page didn't reach the menu (focused: ${focusedNow()})", "Card" !in focusedNow())
        card = -1
        val before = focusedNow()
        // …and Right goes back.
        move(FocusDirection.Right)
        assertTrue("Right from the menu didn't reach the page (focused before: $before; after: ${focusedNow()})", card >= 0)
    }

    private fun focusCard(i: Int) {
        rule.onNodeWithContentDescription("Card $i").performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
    }

    private fun focusedNow(): String =
        rule.onAllNodes(isFocused(), useUnmergedTree = true).fetchSemanticsNodes().joinToString { "${it.config.getOrNull(SemanticsProperties.ContentDescription)} @ ${it.boundsInRoot}" }.ifEmpty { "nothing" }

    @Test
    fun rightFromTheMenuReachesThePage() = rightReachesThePage(alone = false)

    @Test
    fun rightFromTheMenuReachesThePageWhileAlone() = rightReachesThePage(alone = true)
}
