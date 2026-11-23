package com.watchparty.app

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Watch on TV, phone side: the TV this phone is connected to, if any. Anything started from Home then plays there. */
object TvTarget {
    var screen by mutableStateOf<ScreenInfo?>(null)
}

/** The TV's own name, as set in its settings ("Living Room TV"), else its model. */
fun tvLabel(context: Context): String =
    listOf(
        runCatching { Settings.Global.getString(context.contentResolver, "device_name") }.getOrNull(),
        runCatching { Settings.Secure.getString(context.contentResolver, "bluetooth_name") }.getOrNull(),
    ).firstOrNull { !it.isNullOrBlank() } ?: Build.MODEL

/**
 * Watch on TV, TV side: while the app is on screen, keeps a line open to the server so a phone signed in under the same
 * name can list this TV and send it a party, which then opens straight away. Android doesn't let an app in the
 * background bring itself to the front, so the line only stays open while one of the app's screens shows.
 */
object ScreenLink {
    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var url: String? = null
    private var activity: Activity? = null
    private var room: String? = null
    private var attempt = 0
    private val closer = Runnable { close() }
    private val reconnect = Runnable { connect() }

    /** [activity] came on screen; [room] is the party it shows (null for Home). */
    fun attach(activity: Activity, room: String?) {
        main.removeCallbacks(closer)
        this.activity = activity
        this.room = room
        val prefs = Prefs(activity)
        if (prefs.serverUrl.isBlank() || prefs.name.isBlank()) return close()
        val next = Api(prefs.serverUrl, prefs.token).screenSocketUrl(prefs.screenId, prefs.name, tvLabel(activity))
        if (next != url || socket == null) {
            close()
            url = next
            attempt = 0
            connect()
        } else sendStatus()
    }

    /** [activity] left the screen. Closes a moment later unless another of the app's screens takes over. */
    fun detach(activity: Activity) {
        if (this.activity !== activity) return
        this.activity = null
        main.removeCallbacks(closer)
        main.postDelayed(closer, 2_000)
    }

    private fun connect() {
        val target = url ?: return
        if (activity == null) return
        socket = Api.client.newWebSocket(Request.Builder().url(target).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    attempt = 0
                    sendStatus()
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = runCatching { Protocol.json.decodeFromString<ScreenMessage>(text) }.getOrNull() ?: return
                if (msg.type == "watch" && msg.room.isNotBlank()) main.post { open(msg) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.post { retry(webSocket) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post { retry(webSocket) }
            }
        })
    }

    private fun retry(old: WebSocket) {
        if (socket !== old) return
        socket = null
        if (activity == null) return
        attempt++
        main.removeCallbacks(reconnect)
        main.postDelayed(reconnect, (1_000L shl attempt.coerceAtMost(5)).coerceAtMost(30_000))
    }

    private fun close() {
        main.removeCallbacks(reconnect)
        socket?.close(1000, null)
        socket = null
    }

    private fun sendStatus() {
        socket?.send(buildJsonObject {
            put("type", "status")
            put("room", room)
        }.toString())
    }

    /** A phone sent a party: open it, leaving the one on screen. */
    private fun open(msg: ScreenMessage) {
        val current = activity ?: return
        if (msg.room == room) return
        val prefs = Prefs(current)
        // Signed in as the host, the TV can open any party; otherwise it takes the pass for this one.
        val host = prefs.isSetUp && !prefs.token.startsWith("g.")
        if (!host) msg.token?.let { prefs.token = it }
        RoomActivity.start(current, msg.room, host, sentFrom = msg.from, sentTitle = msg.title)
        if (current is RoomActivity) current.finish()
    }
}

/**
 * Watch on TV's list of TVs (see ui-redesign/watch-on-tv): the TVs with the app open, signed in under [name]. Picking
 * one connects to it; [connected] is the one already connected, which can be disconnected here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WatchOnTvSheet(api: Api, name: String, connected: ScreenInfo?, onPick: (ScreenInfo) -> Unit, onDisconnect: () -> Unit, onDismiss: () -> Unit) {
    var screens by remember { mutableStateOf<List<ScreenInfo>?>(null) }
    LaunchedEffect(name) {
        while (true) {
            runCatching { api.screens(name) }.onSuccess { screens = it }
            delay(3_000)
        }
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Panel,
    ) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 12.dp)) {
            Column(Modifier.padding(horizontal = 24.dp)) {
                Text("Watch on TV", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                Text("TVs with Popcorn Club open, signed in as $name.", color = Muted, fontSize = 14.sp, modifier = Modifier.padding(top = 6.dp))
            }
            val list = screens
            Column(Modifier.padding(top = 10.dp)) {
                when {
                    list == null -> Text("Looking for TVs…", color = Muted, fontSize = 14.sp, modifier = Modifier.padding(horizontal = 24.dp, vertical = 14.dp))
                    else -> list.forEach { s -> ScreenRow(s, s.id == connected?.id) { onPick(s) } }
                }
            }
            Text("Don't see your TV? Open Popcorn Club on it.", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 10.dp))
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp), horizontalArrangement = Arrangement.End) {
                if (connected != null) DialogButton("Disconnect") { onDisconnect() }
                DialogButton("Cancel") { onDismiss() }
            }
        }
    }
}

@Composable
private fun ScreenRow(s: ScreenInfo, connected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 24.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Box(Modifier.size(44.dp).clip(CircleShape).background(if (connected) Accent else PanelFocused), contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_nav_shows), contentDescription = null, tint = if (connected) OnFocus else Color.White, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(s.label, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                if (connected) "Connected" else s.watching?.let { "Watching $it" } ?: "Ready",
                color = if (connected) Accent else Muted,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** On the TV, for a few seconds after a phone sent the party: who sent it and what (top right of the player). */
@Composable
fun SentFromCard(from: String, title: String) {
    Row(
        Modifier.clip(RoundedCornerShape(24.dp)).background(Color(0xEB18131F)).padding(horizontal = 26.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(painterResource(R.drawable.ic_smartphone), contentDescription = null, tint = Accent, modifier = Modifier.size(26.dp))
        Column {
            Text("Sent from $from's phone", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
            if (title.isNotBlank()) Text(title, color = Muted, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
