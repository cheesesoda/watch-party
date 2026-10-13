package com.watchparty.app

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
)

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
)

@Serializable
data class BingePosition(val index: Int, val length: Int)

/** A binge: the videos the party plays one after another, and the switch to the next one if it's coming up. */
@Serializable
data class Queue(val items: List<MediaItem> = emptyList(), val advance: Advance? = null) {
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
    ) : ServerMessage

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
    )

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
                ServerMessage.Welcome(it.you, it.roomId, it.state, it.media, it.members, it.chat, it.serverTime, it.iceServers, it.queue)
            }
            "state" -> json.decodeFromJsonElement<StateDto>(obj).let { ServerMessage.State(it.state, it.media, it.by) }
            "members" -> ServerMessage.Members(json.decodeFromJsonElement<MembersDto>(obj).members)
            "chat" -> ServerMessage.Chat(json.decodeFromJsonElement<ChatDto>(obj).message)
            "pong" -> json.decodeFromJsonElement<PongDto>(obj).let { ServerMessage.Pong(it.clientTime, it.serverTime) }
            "error" -> ServerMessage.Error(json.decodeFromJsonElement<ErrorDto>(obj).message)
            "voice-peers" -> ServerMessage.VoicePeers(json.decodeFromJsonElement<VoicePeersDto>(obj).peers)
            "signal" -> json.decodeFromJsonElement<SignalDto>(obj).let { ServerMessage.Signal(it.from, it.data) }
            "queue" -> ServerMessage.QueueChanged(json.decodeFromJsonElement<QueueDto>(obj).queue)
            "ended" -> ServerMessage.Ended(json.decodeFromJsonElement<EndedDto>(obj).by)
            else -> null
        }
    }

    fun position(type: String, position: Double, at: Long? = null): String = buildJsonObject {
        put("type", type)
        put("position", position)
        if (at != null) put("at", at)
    }.toString()

    fun chat(text: String): String = buildJsonObject {
        put("type", "chat")
        put("text", text)
    }.toString()

    fun select(mediaId: String): String = buildJsonObject {
        put("type", "select")
        put("mediaId", mediaId)
    }.toString()

    fun ping(clientTime: Long): String = buildJsonObject {
        put("type", "ping")
        put("clientTime", clientTime)
    }.toString()

    fun end(): String = buildJsonObject { put("type", "end") }.toString()

    /** The video finished on this screen; in a binge, the next one comes up. */
    fun ended(mediaId: String): String = buildJsonObject {
        put("type", "ended")
        put("mediaId", mediaId)
    }.toString()

    /** Host: don't move on to the next video in the binge. */
    fun cancelAdvance(): String = buildJsonObject { put("type", "cancel-advance") }.toString()

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
