package com.watchparty.app

import android.os.Handler
import android.os.Looper
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * WebSocket to one room. Reconnects with backoff until [close] is called.
 * All callbacks run on the main thread.
 */
class RoomConnection(
    private val url: String,
    private val onMessage: (ServerMessage) -> Unit,
    private val onStatus: (Status) -> Unit,
) {
    enum class Status { CONNECTING, OPEN, RECONNECTING, ROOM_GONE, UNAUTHORIZED }

    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var closed = false
    private var attempt = 0

    private val pinner = object : Runnable {
        override fun run() {
            send(Protocol.ping(System.currentTimeMillis()))
            main.postDelayed(this, 10_000)
        }
    }

    fun connect() {
        if (closed) return
        onStatus(if (attempt == 0) Status.CONNECTING else Status.RECONNECTING)
        socket = Api.client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    attempt = 0
                    onStatus(Status.OPEN)
                    // A quick burst of pings gives a good clock estimate right away.
                    for (i in 0 until 4) main.postDelayed({ send(Protocol.ping(System.currentTimeMillis())) }, i * 250L)
                    main.removeCallbacks(pinner)
                    main.postDelayed(pinner, 10_000)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = runCatching { Protocol.parse(text) }.getOrNull() ?: return
                main.post { if (!closed) onMessage(msg) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                main.post { handleDrop(webSocket, if (code == 4404) Status.ROOM_GONE else null) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post { handleDrop(webSocket, if (response?.code == 401) Status.UNAUTHORIZED else null) }
            }
        })
    }

    private fun handleDrop(dropped: WebSocket, terminal: Status?) {
        // Ignore late callbacks from a socket we've already replaced.
        if (closed || dropped !== socket) return
        socket = null
        main.removeCallbacks(pinner)
        if (terminal != null) {
            onStatus(terminal)
            return
        }
        onStatus(Status.RECONNECTING)
        val delay = minOf(10_000L, 500L shl minOf(attempt, 5))
        attempt++
        main.postDelayed({ connect() }, delay)
    }

    fun send(text: String) {
        socket?.send(text)
    }

    fun close() {
        closed = true
        main.removeCallbacksAndMessages(null)
        socket?.close(1000, "bye")
    }
}
