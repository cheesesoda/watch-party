package com.watchparty.app

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The TV's side menu with the remote: Right from it has to reach the page (a grid of posters, like Movies). */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi-television")
class TvMenuFocusTest {
    @get:Rule
    val rule = createComposeRule()

    private fun page(alone: Boolean, focused: (Int) -> Unit) = rule.setContent {
        TvShell("movies", adding = false, alone = alone, setAlone = {}, onCode = {}, onRefresh = {}, onSettings = {}, go = {}) {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(118.dp),
                contentPadding = PaddingValues(start = 96.dp, end = 48.dp, top = 32.dp, bottom = 32.dp),
                horizontalArrangement = Arrangement.spacedBy(22.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                items(18) { i -> Box(Modifier.aspectRatio(2f / 3f).onFocusChanged { if (it.isFocused) focused(i) }.clickable {}) }
            }
        }
    }

    private fun rightReachesThePage(alone: Boolean) {
        var card = -1
        page(alone) { card = it }
        rule.onNodeWithContentDescription("Movies").performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
        rule.onRoot().performKeyInput { pressKey(Key.DirectionRight) }
        rule.waitForIdle()
        assertTrue("Right from the menu didn't reach the page", card >= 0)
    }

    @Test
    fun rightFromTheMenuReachesThePage() = rightReachesThePage(alone = false)

    @Test
    fun rightFromTheMenuReachesThePageWhileAlone() = rightReachesThePage(alone = true)
}
