package com.watchparty.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val Bg = Color(0xFF0F1115)
private val Panel = Color(0xFF181B22)
private val Accent = Color(0xFFE5A00D)
private val Muted = Color(0xFF9097A6)
private val ErrorColor = Color(0xFFFF7A6B)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(primary = Accent, onPrimary = Bg, background = Bg, surface = Panel),
            ) {
                var setUp by remember { mutableStateOf(prefs.isSetUp) }
                var notice by remember { mutableStateOf<String?>(null) }
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(Bg)
                        .safeDrawingPadding(),
                ) {
                    if (setUp) {
                        HomeScreen(
                            prefs = prefs,
                            onSignedOut = { message ->
                                prefs.markSignedIn(false)
                                notice = message
                                setUp = false
                            },
                        )
                    } else {
                        SetupScreen(prefs = prefs, notice = notice, onDone = { notice = null; setUp = true })
                    }
                }
            }
        }
    }
}

@Composable
private fun SetupScreen(prefs: Prefs, notice: String?, onDone: () -> Unit) {
    var server by remember { mutableStateOf(prefs.serverUrl) }
    var name by remember { mutableStateOf(prefs.name) }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf(notice) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val submit: () -> Unit = submit@{
        val url = Prefs.normalizeUrl(server)
        if (url.isEmpty()) {
            error = "Enter your server address, like 192.168.1.20:8080."
            return@submit
        }
        if (name.isBlank()) {
            error = "Pick a name so friends know who's talking."
            return@submit
        }
        busy = true
        error = null
        scope.launch {
            try {
                val token = Api(url, "").login(password)
                prefs.serverUrl = url
                prefs.token = token
                prefs.name = name.trim().take(32)
                prefs.markSignedIn(true)
                onDone()
            } catch (e: Exception) {
                error = e.message ?: "Couldn't reach the server."
            } finally {
                busy = false
            }
        }
    }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier
                .widthIn(max = 420.dp)
                .padding(24.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Panel)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Watch Party", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
            OutlinedTextField(
                value = server,
                onValueChange = { server = it },
                label = { Text("Server address") },
                placeholder = { Text("192.168.1.20:8080") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(32) },
                label = { Text("Your name") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Server password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            error?.let { Text(it, color = ErrorColor) }
            Button(onClick = submit, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Text(if (busy) "Connecting…" else "Continue")
            }
        }
    }
}

@Composable
private fun HomeScreen(prefs: Prefs, onSignedOut: (String?) -> Unit) {
    val api = remember { Api(prefs.serverUrl, prefs.token) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var rooms by remember { mutableStateOf<List<RoomSummary>>(emptyList()) }
    var library by remember { mutableStateOf<List<MediaItem>?>(null) }
    var query by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun <T> guard(block: suspend () -> T): T? = try {
        block()
    } catch (e: UnauthorizedException) {
        onSignedOut("Signed out. Check the server password.")
        null
    } catch (e: Exception) {
        error = e.message ?: "Couldn't reach the server."
        null
    }

    LaunchedEffect(Unit) {
        guard { api.library() }?.let { library = it }
    }
    LaunchedEffect(Unit) {
        while (true) {
            guard { api.rooms() }?.let { rooms = it }
            delay(5000)
        }
    }

    val joinCode: () -> Unit = {
        val id = Prefs.roomCode(code)
        if (id.isNotEmpty()) {
            scope.launch {
                guard { api.room(id) }?.let { RoomActivity.start(context, it.id) }
            }
        }
    }

    LazyColumn(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Row(Modifier.padding(top = 20.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Watch Party", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
                    Text("${prefs.name} on ${prefs.serverUrl}", color = Muted, fontSize = 13.sp)
                }
                OutlinedButton(onClick = { onSignedOut(null) }) { Text("Settings") }
            }
        }
        error?.let { item { Text(it, color = ErrorColor) } }

        item { SectionTitle("Watch parties") }
        if (rooms.isEmpty()) {
            item { Text("Nobody is watching yet. Pick something below to start a party.", color = Muted) }
        }
        items(rooms, key = { "room-" + it.id }) { room ->
            FocusRow(
                title = room.media?.title ?: "Nothing selected",
                subtitle = (if (room.members.isEmpty()) "empty" else room.members.map { it.name }.distinct().joinToString(", ")) + " · code ${room.id}",
                action = "Join",
                onClick = { RoomActivity.start(context, room.id) },
            )
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it },
                    label = { Text("Room code or invite link") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                    modifier = Modifier.weight(1f),
                )
                Button(onClick = joinCode) { Text("Join") }
            }
        }

        item { SectionTitle("Library") }
        item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text("Search") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                OutlinedButton(onClick = {
                    scope.launch { guard { api.library() }?.let { library = it } }
                }) { Text("Refresh") }
            }
        }
        val lib = library
        if (lib == null) {
            item { Text("Loading library…", color = Muted) }
        } else {
            val filtered = lib.filter { query.isBlank() || it.relPath.contains(query.trim(), ignoreCase = true) }
            if (filtered.isEmpty()) item { Text("No videos found.", color = Muted) }
            var lastFolder: String? = null
            for (media in filtered) {
                if (media.folder != lastFolder && media.folder.isNotEmpty()) {
                    val folder = media.folder
                    item(key = "folder-$folder") {
                        Text(folder, color = Muted, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp))
                    }
                }
                lastFolder = media.folder
                item(key = "media-" + media.id) {
                    FocusRow(
                        title = media.title,
                        subtitle = formatSize(media.size) + if (media.subtitles.isNotEmpty()) " · CC" else "",
                        action = "Start party",
                        onClick = {
                            scope.launch {
                                guard { api.createRoom(media.id) }?.let { RoomActivity.start(context, it.id) }
                            }
                        },
                    )
                }
            }
        }
        item { Spacer(Modifier.padding(bottom = 24.dp)) }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        fontSize = 18.sp,
        fontWeight = FontWeight.SemiBold,
        color = Color.White,
        modifier = Modifier.padding(top = 16.dp, bottom = 4.dp),
    )
}

/** A list row that shows a clear highlight when focused with a TV remote. */
@Composable
private fun FocusRow(title: String, subtitle: String, action: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(10.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (focused) Color(0xFF2A2F3B) else Panel)
            .border(2.dp, if (focused) Accent else Color.Transparent, shape)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = Color.White, fontWeight = FontWeight.Medium)
            Text(subtitle, color = Muted, fontSize = 13.sp)
        }
        Spacer(Modifier.width(12.dp))
        Text(action, color = Accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

private fun formatSize(bytes: Long): String {
    val gb = bytes / (1024.0 * 1024 * 1024)
    return if (gb >= 1) String.format("%.1f GB", gb) else "${maxOf(1, bytes / (1024 * 1024))} MB"
}
