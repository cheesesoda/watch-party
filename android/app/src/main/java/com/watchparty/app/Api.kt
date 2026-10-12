package com.watchparty.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
    @Serializable private data class ErrorResponse(val error: String? = null)

    private val jsonType = "application/json".toMediaType()

    private suspend fun request(path: String, body: String? = null): String = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(baseUrl + path)
        if (token.isNotEmpty()) builder.header("Authorization", "Bearer $token")
        if (body != null) builder.post(body.toRequestBody(jsonType))
        client.newCall(builder.build()).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (res.code == 401 && !path.endsWith("/login") && !path.endsWith("/join")) throw UnauthorizedException()
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
        val client: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}
