package com.watchparty.app

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

// Mirrors shared/protocol.ts. Keep the two in sync.

@Serializable
data class SubtitleTrack(val index: Int, val label: String, val lang: String? = null)

@Serializable
data class MediaItem(
    val id: String,
    val title: String,
    val relPath: String,
    val folder: String = "",
    val size: Long = 0,
    val mime: String = "",
    val subtitles: List<SubtitleTrack> = emptyList(),
    /** When the file landed in the library, ms since epoch. */
    val addedAt: Long = 0,
    /** Release year read from the file name. */
    val year: Int? = null,
    /** Seconds, once the server has read the file; null until then. */
    val duration: Double? = null,
    /** Set when the file name looks like a TV episode. */
    val episode: EpisodeInfo? = null,
    /** Set for bonus material (behind the scenes, trailers…), with the movie id or show name it belongs to. */
    val extra: ExtraInfo? = null,
    /** Details from TMDB, when the server has a TMDB token and found a match. */
    val meta: MediaMeta? = null,
    /** One piece of a movie split into files ("Pt 1", "Pt 2"): which one, and every part's id in order. */
    val part: PartInfo? = null,
    /** Where its intro, recap and credits are, once the server has found them (see SkipMarks). */
    val marks: SkipMarks? = null,
    /** Its watched mark, kept for everyone on the server; null if it never played or was marked not watched. */
    val watch: WatchState? = null,
)

/** A video's watched mark: when it was watched (or marked watched), or how far in it stopped. */
@Serializable
data class WatchState(val watchedAt: Long? = null, val position: Double? = null, val updatedAt: Long = 0)

/** One video played in one party (or Watch alone), as History lists it, newest first. */
@Serializable
data class HistoryEntry(
    val id: String,
    val mediaId: String,
    val startedAt: Long,
    val lastAt: Long,
    /** Where it was the last time it played (seconds). */
    val position: Double = 0.0,
    /** Everyone who was there. */
    val names: List<String> = emptyList(),
    /** Watched alone the whole time. */
    val solo: Boolean = false,
    /** It reached the credits. */
    val watched: Boolean = false,
    val media: MediaItem,
)

/**
 * Parts of a video people skip, in seconds: intros and credits the server found by comparing a season's episodes,
 * recaps from chapter names.
 */
@Serializable
data class SkipMarks(val intro: TimeRange? = null, val recap: TimeRange? = null, val credits: Double? = null)

@Serializable
data class TimeRange(val start: Double, val end: Double)

/** The intro or recap playing at [position] and where it ends, for Skip intro / Skip recap; not in its last 2 s. Same as the web's. */
fun skippable(marks: SkipMarks?, position: Double): Pair<String, Double>? {
    for ((kind, part) in listOf("recap" to marks?.recap, "intro" to marks?.intro)) {
        if (part != null && position >= part.start && position < part.end - 2) return kind to part.end
    }
    return null
}

@Serializable
data class PartInfo(val index: Int, val ids: List<String>)

/** Movie or episode details from TMDB. Image paths are TMDB file paths, loaded through the server. */
@Serializable
data class MediaMeta(
    /** The movie's TMDB id, or the show's for an episode. */
    val tmdbId: Long,
    /** The movie's title, or the episode's name. */
    val title: String,
    val year: Int? = null,
    val overview: String? = null,
    /** Movie poster, or the season's for an episode. */
    val posterPath: String? = null,
    /** The episode's still image. */
    val stillPath: String? = null,
    /** When the episode first aired, "2019-12-25" (TMDB). */
    val airDate: String? = null,
    /** The show's name as TMDB has it, and its own poster and summary, for episodes. */
    val show: String? = null,
    val showPosterPath: String? = null,
    val showOverview: String? = null,
    /** Wide background art: the movie's, or the show's for an episode. */
    val backdropPath: String? = null,
    /** TMDB's average score out of 10 (the show's for an episode). */
    val rating: Double? = null,
    /** "Comedy", "Crime"… (the show's for an episode). */
    val genres: List<String> = emptyList(),
)

@Serializable
data class EpisodeInfo(val show: String, val season: Int, val episode: Int, val title: String? = null)

@Serializable
data class ExtraInfo(val kind: String, val of: String? = null, val show: String? = null)

/** What ffprobe found in a file. Mirrors MediaInfo in shared/protocol.ts. */
@Serializable
data class MediaInfo(
    val container: String = "",
    val duration: Double = 0.0,
    val video: Video? = null,
    val audio: Audio? = null,
    /** The server can convert this file (ffmpeg is installed). */
    val convert: Boolean = false,
    /** Text subtitles inside the file, served as WebVTT at [Api.subtitleUrl] with "e" + index. */
    val subtitles: List<SubtitleTrack> = emptyList(),
) {
    @Serializable data class Video(val codec: String, val width: Int = 0, val height: Int = 0, val pixFmt: String = "")
    @Serializable data class Audio(val codec: String, val channels: Int = 0)
}

@Serializable
data class PlaybackState(
    val mediaId: String? = null,
    val paused: Boolean = true,
    /** Seconds at [updatedAt]. */
    val position: Double = 0.0,
    /** Server clock, ms since epoch. */
    val updatedAt: Long = 0,
    /** Paused only until every screen has loaded the spot someone jumped to; this one says "ready" when it has. */
    val hold: Boolean = false,
) {
    /** Where playback should be at [serverNow] (ms), in seconds. */
    fun expectedPosition(serverNow: Long): Double =
        if (paused) position else position + maxOf(0L, serverNow - updatedAt) / 1000.0
}

@Serializable
data class Member(
    val id: String,
    val name: String,
    /** In the room's voice chat. */
    val voice: Boolean = false,
    /** Not sending audio: muted, or listening only. */
    val muted: Boolean = true,
    /** "web", "phone" or "tv". */
    val device: String = "web",
)

@Serializable
data class IceServer(val urls: List<String>, val username: String? = null, val credential: String? = null)

@Serializable
data class ChatMessage(
    val id: String,
    val from: String,
    val text: String,
    val ts: Long,
    val system: Boolean = false,
)

/** Where a party is in its video, in seconds. Duration is null when the server can't read it. */
@Serializable
data class RoomPlayback(val position: Double, val paused: Boolean, val duration: Double? = null)

@Serializable
data class RoomSummary(
    val id: String,
    val media: MediaItem? = null,
    val members: List<Member> = emptyList(),
    val playback: RoomPlayback? = null,
    /** Set for a binge: where the party is in it, e.g. 3 of 10. */
    val binge: BingePosition? = null,
    /** The next video in Up next, and how many there are in all after the one playing now. */
    val upNext: UpNextInfo? = null,
    /** The host watching alone, until they invite friends. */
    val solo: Boolean = false,
)

@Serializable
data class UpNextInfo(val item: MediaItem, val count: Int)

/** A party set up for later (Schedule, on the web). Its code works from the start; it opens 30 minutes before [at]. */
@Serializable
data class ScheduledParty(
    val id: String,
    /** When it starts (ms since epoch). */
    val at: Long,
    /** The first video, and how many are lined up in all (1 for a movie). */
    val media: MediaItem? = null,
    val count: Int = 1,
)

/** What a friend with a scheduled party's code is told before it opens. */
@Serializable
data class PartyInvite(
    val id: String,
    val at: Long,
    /** When the code starts joining the party (ms since epoch). */
    val opensAt: Long,
    /** "Charade", or "Reacher · S2 E1" for an episode. */
    val title: String,
    /** Who scheduled it, for "Jake's party". */
    val host: String? = null,
    /** The first video's length in seconds, for the calendar event. */
    val duration: Double? = null,
)

/** Where a party stopped, saved so a new party can pick up there ("Pick up where you left off"). */
@Serializable
data class Spot(
    val id: String,
    /** The video to start, and how far into it (seconds). */
    val media: MediaItem,
    val position: Double,
    /** What was still lined up after it, in order. */
    val next: List<MediaItem> = emptyList(),
    /** When it was saved (ms since epoch). */
    val savedAt: Long,
)

/**
 * Close enough to the end that the video counts as watched: in its credits (when the server found where they start),
 * or the last minute, or the last 5% for long ones.
 */
fun nearEnd(position: Double, duration: Double?, credits: Double? = null): Boolean =
    (credits != null && position >= credits) ||
        (duration != null && duration > 0 && position >= duration - maxOf(60.0, duration * 0.05))

/**
 * Whether a party stopping here is worth picking up later: partway through a video (past the first minute and not at
 * the credits), or with more lined up after it. Same as the server's.
 */
fun worthSaving(position: Double, duration: Double?, upcoming: Int, credits: Double? = null): Boolean =
    if (nearEnd(position, duration, credits)) upcoming > 0 else position >= 60 || upcoming > 0

@Serializable
data class BingePosition(val index: Int, val length: Int)

/**
 * A binge or Up next: the videos the party plays one after another (the ones already played, the one playing now
 * and the ones after it), and the switch to the next one if it's coming up.
 */
@Serializable
data class Queue(
    val items: List<MediaItem> = emptyList(),
    val advance: Advance? = null,
    /** Which of [items] is playing now; -1 when none of them is. Older servers leave it out. */
    val at: Int? = null,
) {
    /** Where the video playing now ([playing], its id) sits in [items], or -1. */
    fun indexOf(playing: String?): Int = at?.takeIf { it in items.indices } ?: items.indexOfFirst { it.id == playing }

    /** Up next: the videos after the one playing now. */
    fun upcoming(playing: String?): List<MediaItem> = indexOf(playing).let { i -> if (i < 0) emptyList() else items.drop(i + 1) }

    /** Counting down to the next video: which one, and when it starts (server clock, ms). */
    @Serializable
    data class Advance(val mediaId: String, val at: Long)
}

sealed interface ServerMessage {
    data class Welcome(
        val you: Member,
        val roomId: String,
        val state: PlaybackState,
        val media: MediaItem?,
        val members: List<Member>,
        val chat: List<ChatMessage>,
        val serverTime: Long,
        val iceServers: List<IceServer>,
        val queue: Queue? = null,
        /** The host is watching alone, until they invite friends. */
        val solo: Boolean = false,
    ) : ServerMessage

    /** The host invited friends: no longer watching alone. */
    data class Solo(val solo: Boolean) : ServerMessage

    /** The binge changed: started, moved on, counting down to the next video, or stopped (null). */
    data class QueueChanged(val queue: Queue?) : ServerMessage

    data class State(val state: PlaybackState, val media: MediaItem?, val by: String?) : ServerMessage
    data class Members(val members: List<Member>) : ServerMessage
    data class Chat(val message: ChatMessage) : ServerMessage
    data class Pong(val clientTime: Long, val serverTime: Long) : ServerMessage
    data class Error(val message: String) : ServerMessage

    /** We just joined voice; call these members. */
    data class VoicePeers(val peers: List<String>) : ServerMessage

    /** WebRTC negotiation from another voice member: `{sdp: {type, sdp}}` or `{candidate: {...}}`. */
    data class Signal(val from: String, val data: JsonObject) : ServerMessage

    /** Someone ended the party; the server disconnects everyone right after. */
    data class Ended(val by: String) : ServerMessage
}

object Protocol {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }

    @Serializable
    private data class WelcomeDto(
        val you: Member,
        val roomId: String,
        val state: PlaybackState,
        val media: MediaItem? = null,
        val members: List<Member> = emptyList(),
        val chat: List<ChatMessage> = emptyList(),
        val serverTime: Long,
        val iceServers: List<IceServer> = emptyList(),
        val queue: Queue? = null,
        val solo: Boolean = false,
    )

    @Serializable
    private data class SoloDto(val solo: Boolean = false)

    @Serializable
    private data class QueueDto(val queue: Queue? = null)

    @Serializable
    private data class StateDto(val state: PlaybackState, val media: MediaItem? = null, val by: String? = null)

    @Serializable
    private data class MembersDto(val members: List<Member>)

    @Serializable
    private data class ChatDto(val message: ChatMessage)

    @Serializable
    private data class PongDto(val clientTime: Long, val serverTime: Long)

    @Serializable
    private data class ErrorDto(val message: String)

    @Serializable
    private data class VoicePeersDto(val peers: List<String>)

    @Serializable
    private data class SignalDto(val from: String, val data: JsonObject)

    @Serializable
    private data class EndedDto(val by: String = "")

    /** Returns null for message types this app version doesn't know. */
    fun parse(text: String): ServerMessage? {
        val obj: JsonObject = json.parseToJsonElement(text).jsonObject
        return when (obj["type"]?.jsonPrimitive?.content) {
            "welcome" -> json.decodeFromJsonElement<WelcomeDto>(obj).let {
                ServerMessage.Welcome(it.you, it.roomId, it.state, it.media, it.members, it.chat, it.serverTime, it.iceServers, it.queue, it.solo)
            }
            "state" -> json.decodeFromJsonElement<StateDto>(obj).let { ServerMessage.State(it.state, it.media, it.by) }
            "members" -> ServerMessage.Members(json.decodeFromJsonElement<MembersDto>(obj).members)
            "chat" -> ServerMessage.Chat(json.decodeFromJsonElement<ChatDto>(obj).message)
            "pong" -> json.decodeFromJsonElement<PongDto>(obj).let { ServerMessage.Pong(it.clientTime, it.serverTime) }
            "error" -> ServerMessage.Error(json.decodeFromJsonElement<ErrorDto>(obj).message)
            "voice-peers" -> ServerMessage.VoicePeers(json.decodeFromJsonElement<VoicePeersDto>(obj).peers)
            "signal" -> json.decodeFromJsonElement<SignalDto>(obj).let { ServerMessage.Signal(it.from, it.data) }
            "queue" -> ServerMessage.QueueChanged(json.decodeFromJsonElement<QueueDto>(obj).queue)
            "solo" -> ServerMessage.Solo(json.decodeFromJsonElement<SoloDto>(obj).solo)
            "ended" -> ServerMessage.Ended(json.decodeFromJsonElement<EndedDto>(obj).by)
            else -> null
        }
    }

    fun position(type: String, position: Double, at: Long? = null, skip: String? = null): String = buildJsonObject {
        put("type", type)
        put("position", position)
        if (at != null) put("at", at)
        if (skip != null) put("skip", skip)
    }.toString()

    /** A jump's wait gave up on this device before it loaded; now it has caught up (for the server's log). */
    fun caughtUp(position: Double): String = buildJsonObject {
        put("type", "ready")
        put("position", position)
        put("late", true)
    }.toString()

    /** This device changed its video quality (for the server's log). [auto]: by itself, after waiting for video too often. */
    fun quality(light: Boolean, auto: Boolean): String = buildJsonObject {
        put("type", "quality")
        put("light", light)
        if (auto) put("auto", true)
    }.toString()

    /** Whether this device plays the video (false while it's only for chat), so jumps wait for it to load. */
    fun player(on: Boolean): String = buildJsonObject {
        put("type", "player")
        put("on", on)
    }.toString()

    fun chat(text: String): String = buildJsonObject {
        put("type", "chat")
        put("text", text)
    }.toString()

    fun select(mediaId: String): String = buildJsonObject {
        put("type", "select")
        put("mediaId", mediaId)
    }.toString()

    /** Host: play these videos one after another, starting now (replaces Up next). */
    fun binge(mediaIds: List<String>): String = buildJsonObject {
        put("type", "binge")
        put("mediaIds", JsonArray(mediaIds.map { JsonPrimitive(it) }))
    }.toString()

    /** Host: add these videos to the end of Up next. */
    fun queueAdd(mediaIds: List<String>): String = buildJsonObject {
        put("type", "queue-add")
        put("mediaIds", JsonArray(mediaIds.map { JsonPrimitive(it) }))
    }.toString()

    fun queueRemove(mediaId: String): String = buildJsonObject {
        put("type", "queue-remove")
        put("mediaId", mediaId)
    }.toString()

    /** Host: move a video in Up next to place [to] (0 is next). */
    fun queueMove(mediaId: String, to: Int): String = buildJsonObject {
        put("type", "queue-move")
        put("mediaId", mediaId)
        put("to", to)
    }.toString()

    fun queueClear(): String = buildJsonObject { put("type", "queue-clear") }.toString()

    fun ping(clientTime: Long): String = buildJsonObject {
        put("type", "ping")
        put("clientTime", clientTime)
    }.toString()

    /** Ends the party for everyone. [save]: keep its spot on Home under "Pick up where you left off". */
    fun end(save: Boolean = false): String = buildJsonObject {
        put("type", "end")
        if (save) put("save", true)
    }.toString()

    /** Host, watching alone: open it up as a party so friends can join. */
    fun invite(): String = buildJsonObject { put("type", "invite") }.toString()

    /** The video finished on this screen; in a binge, the next one comes up. */
    fun ended(mediaId: String): String = buildJsonObject {
        put("type", "ended")
        put("mediaId", mediaId)
    }.toString()

    /** Host: don't move on to the next video in the binge. */
    fun cancelAdvance(): String = buildJsonObject { put("type", "cancel-advance") }.toString()

    /** Play now on the Up next card: the video it counts down to starts now. Anyone can. */
    fun advanceNow(): String = buildJsonObject { put("type", "advance-now") }.toString()

    fun voice(on: Boolean, muted: Boolean): String = buildJsonObject {
        put("type", "voice")
        put("on", on)
        put("muted", muted)
    }.toString()

    fun signal(to: String, data: JsonObject): String = buildJsonObject {
        put("type", "signal")
        put("to", to)
        put("data", data)
    }.toString()

    fun sdpSignal(type: String, sdp: String): JsonObject = buildJsonObject {
        put("sdp", buildJsonObject {
            put("type", type)
            put("sdp", sdp)
        })
    }

    fun candidateSignal(candidate: String, sdpMid: String?, sdpMLineIndex: Int): JsonObject = buildJsonObject {
        put("candidate", buildJsonObject {
            put("candidate", candidate)
            put("sdpMid", sdpMid)
            put("sdpMLineIndex", sdpMLineIndex)
        })
    }
}
