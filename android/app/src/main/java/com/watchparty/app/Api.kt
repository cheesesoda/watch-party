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
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
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

    /** Ends a party for everyone in it, without joining. Host only. */
    suspend fun endRoom(id: String, name: String) {
        request("/api/rooms/$id/end", buildJsonObject { put("name", name) }.toString())
    }

    /** queue: a binge, the videos to play one after another from the first. */
    suspend fun createRoom(mediaId: String?, queue: List<String>? = null): RoomSummary {
        val body = buildJsonObject {
            if (mediaId != null) put("mediaId", mediaId)
            if (queue != null) put("queue", kotlinx.serialization.json.JsonArray(queue.map { kotlinx.serialization.json.JsonPrimitive(it) }))
        }.toString()
        return Protocol.json.decodeFromString<RoomResponse>(request("/api/rooms", body)).room
    }

    /** Codecs and length of a file, or null when the server can't read them (no ffprobe). */
    suspend fun info(mediaId: String): MediaInfo? =
        Protocol.json.decodeFromString<InfoResponse>(request("/api/media/$mediaId/info")).info

    /** The server's converted copy (H.264, stereo AAC, at most 1080p). Segments need [authHeaders]. */
    /**
     * A TMDB poster or still (a path like "/abc.jpg"), through the server so the device never contacts TMDB.
     * null if it can't be loaded.
     */
    suspend fun image(path: String, size: String): ImageBitmap? {
        val url = "$baseUrl/api/images/$size$path"
        images.get(url)?.let { return it }
        return withContext(Dispatchers.IO) {
            runCatching {
                val builder = Request.Builder().url(url)
                if (token.isNotEmpty()) builder.header("Authorization", "Bearer $token")
                client.newCall(builder.build()).execute().use { res ->
                    if (!res.isSuccessful) return@use null
                    val bytes = res.body?.bytes() ?: return@use null
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                }
            }.getOrNull()?.also { images.put(url, it) }
        }
    }

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

        /** Posters already loaded, by URL, so scrolling back doesn't load them again. */
        // Backdrops are big (a 1280-wide one is about 3.5 MB decoded), so the cache grows with the app's memory.
        private val images = object : LruCache<String, ImageBitmap>((Runtime.getRuntime().maxMemory() / 6).toInt().coerceIn(24 shl 20, 96 shl 20)) {
            override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
        }

        val client: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}
