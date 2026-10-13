package com.watchparty.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.ui.Modifier

/**
 * "Add videos" from the player's Up next: the host's library (the same pages as the home screen), where videos go
 * into Up next or play for everyone. The party's player stays open underneath; Back or "Back to party" returns to it.
 */
class AddVideosActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Nothing to add to once the party is gone (say, Android restarted the app on this screen).
        if (PartyLink.party == null) return finish()
        val prefs = Prefs(this)
        setContent {
            PopcornTheme {
                Box(Modifier.fillMaxSize().background(Bg).safeDrawingPadding()) {
                    Dashboard(prefs, onSignedOut = { finish() }, adding = true, onBackToParty = { finish() })
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (PartyLink.party == null) finish()
    }
}
