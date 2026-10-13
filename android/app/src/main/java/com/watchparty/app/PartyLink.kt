package com.watchparty.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * The party the host is in, for the library's "Add videos" screen ([AddVideosActivity]): it sends through the
 * player's connection, which stays open behind it, and shows what's already in Up next. Set by [RoomActivity].
 */
object PartyLink {
    class Party(val code: String, val send: (String) -> Unit)

    /** The host's open party; null when there's none (or this screen belongs to a guest). */
    var party by mutableStateOf<Party?>(null)
    /** What the party is playing now, and its binge or Up next. */
    var playing by mutableStateOf<String?>(null)
    var queue by mutableStateOf<Queue?>(null)

    val upcoming: List<MediaItem> get() = queue?.upcoming(playing).orEmpty()

    fun queued(id: String) = upcoming.any { it.id == id }
}
