package com.watchparty.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class UnauthorizedException : IOException("Not signed in.")
class ApiException(message: String) : IOException(message)

/** REST calls to the watch party server. */
class Api(private val baseUrl: String, private val token: String) {

    @Serializable private data class LoginResponse(val token: String)
    @Serializable private data class LibraryResponse(val items: List<MediaItem>)
    @Serializable private data class RoomsResponse(val rooms: List<RoomSummary>)
    @Serializable private data class RoomResponse(val room: RoomSummary)
    @Serializable data class JoinResponse(val token: String? = null, val room: RoomSummary)
    @Serializable data class Pairing(val id: String, val expiresIn: Int = 600)
    /** A TV sign-in: "waiting" until the phone finishes, then "done" with the pass (role host or guest). */
    @Serializable data class PairStatus(
        val status: String,
        val role: String? = null,
        val token: String? = null,
        val room: String? = null,
        val name: String? = null,
    )
    @Serializable private data class InfoResponse(val info: MediaInfo? = null)
    @Serializable private data class ErrorResponse(val error: String? = null)

    private val jsonType = "application/json".toMediaType()

    private suspend fun request(path: String, body: String? = null): String = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(baseUrl + path)
        if (token.isNotEmpty()) builder.header("Authorization", "Bearer $token")
        if (body != null) builder.post(body.toRequestBody(jsonType))
        client.newCall(builder.build()).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (res.code == 401 && !path.endsWith("/login") && !path.endsWith("/join") && !path.startsWith("/api/pair")) throw UnauthorizedException()
            if (!res.isSuccessful) {
                val msg = runCatching { Protocol.json.decodeFromString<ErrorResponse>(text).error }.getOrNull()
                throw ApiException(msg ?: "Server returned ${res.code}")
            }
            text
        }
    }

    suspend fun login(password: String): String {
        val body = buildJsonObject { put("password", password) }.toString()
        return Protocol.json.decodeFromString<LoginResponse>(request("/api/login", body)).token
    }

    /** Joins a party by its code. Viewers get a pass for just that party; a signed-in host gets a null token. */
    suspend fun join(code: String): JoinResponse {
        val body = buildJsonObject { put("code", code.trim()) }.toString()
        return Protocol.json.decodeFromString<JoinResponse>(request("/api/join", body))
    }

    /** Starts a TV sign-in; show `pairUrl(id)` as a QR code and poll `pairStatus(id)`. */
    suspend fun createPairing(): Pairing =
        Protocol.json.decodeFromString<Pairing>(request("/api/pair", "{}"))

    suspend fun pairStatus(id: String): PairStatus =
        Protocol.json.decodeFromString<PairStatus>(request("/api/pair/$id"))

    fun pairUrl(id: String): String = "$baseUrl/pair/$id"

    /** From the phone: sign the TV in with a party code, or as the host (this phone's sign-in or the password). */
    suspend fun completePairing(id: String, name: String, code: String?, password: String?) {
        val body = buildJsonObject {
            put("name", name)
            if (code != null) put("code", code)
            if (password != null) put("password", password)
        }.toString()
        request("/api/pair/$id", body)
    }

    suspend fun me() {
        request("/api/me")
    }

    suspend fun library(): List<MediaItem> =
        Protocol.json.decodeFromString<LibraryResponse>(request("/api/library")).items

    suspend fun rooms(): List<RoomSummary> =
        Protocol.json.decodeFromString<RoomsResponse>(request("/api/rooms")).rooms

    suspend fun room(id: String): RoomSummary =
        Protocol.json.decodeFromString<RoomResponse>(request("/api/rooms/$id")).room

    suspend fun createRoom(mediaId: String?): RoomSummary {
        val body = buildJsonObject { if (mediaId != null) put("mediaId", mediaId) }.toString()
        return Protocol.json.decodeFromString<RoomResponse>(request("/api/rooms", body)).room
    }

    /** Codecs and length of a file, or null when the server can't read them (no ffprobe). */
    suspend fun info(mediaId: String): MediaInfo? =
        Protocol.json.decodeFromString<InfoResponse>(request("/api/media/$mediaId/info")).info

    /** The server's converted copy (H.264, stereo AAC, at most 1080p). Segments need [authHeaders]. */
    fun hlsUrl(mediaId: String): String = "$baseUrl/api/media/$mediaId/hls/index.m3u8"

    /** Sent with every video request, since HLS segment links don't carry the token. */
    fun authHeaders(): Map<String, String> = if (token.isEmpty()) emptyMap() else mapOf("Authorization" to "Bearer $token")

    fun streamUrl(mediaId: String): String = withToken("$baseUrl/api/media/$mediaId/stream")

    fun subtitleUrl(mediaId: String, index: Int): String = withToken("$baseUrl/api/media/$mediaId/subtitles/$index.vtt")

    fun socketUrl(roomId: String, name: String, device: String): String {
        val url = "$baseUrl/ws".toHttpUrl().newBuilder()
            .addQueryParameter("room", roomId)
            .addQueryParameter("name", name)
            .addQueryParameter("device", device)
            .apply { if (token.isNotEmpty()) addQueryParameter("token", token) }
            .build()
            .toString()
        return url.replaceFirst("http", "ws")
    }

    private fun withToken(url: String): String =
        if (token.isEmpty()) url else url.toHttpUrl().newBuilder().addQueryParameter("token", token).build().toString()

    companion object {
        /**
         * Follows any redirect (say, a short domain forwarding to a ts.net address) and returns the server it lands on,
         * so later calls, including POSTs and the websocket, go straight there.
         */
        suspend fun resolveServer(url: String): String = withContext(Dispatchers.IO) {
            client.newCall(Request.Builder().url("$url/api/health").build()).execute().use { res ->
                val final = res.request.url
                val port = if (final.port != HttpUrl.defaultPort(final.scheme)) ":${final.port}" else ""
                "${final.scheme}://${final.host}$port"
            }
        }

        val client: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}
