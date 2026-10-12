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
import androidx.compose.material3.TextButton
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

/** First screen for anyone who isn't signed in as the host: join with a code, or start a party with the password. */
@Composable
private fun SetupScreen(prefs: Prefs, notice: String?, onDone: () -> Unit) {
    var mode by remember { mutableStateOf<String?>(null) }
    when (mode) {
        "start" -> StartForm(prefs, notice, onDone, onBack = { mode = null })
        "join" -> JoinForm(prefs, onBack = { mode = null })
        else -> FormCard {
            Text("Popcorn Club", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
            notice?.let { Text(it, color = ErrorColor) }
            Button(onClick = { mode = "join" }, modifier = Modifier.fillMaxWidth()) { Text("Join a party") }
            OutlinedButton(onClick = { mode = "start" }, modifier = Modifier.fillMaxWidth()) { Text("Start a party") }
            Text("Joining needs the party code from your host. Starting one needs the server password.", color = Muted, fontSize = 13.sp)
        }
    }
}

@Composable
private fun FormCard(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier
                .widthIn(max = 420.dp)
                .padding(24.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Panel)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) { content() }
    }
}

@Composable
private fun ServerField(value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text("Server address") },
        placeholder = { Text("party.example.com") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun NameField(value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = { onChange(it.take(32)) },
        label = { Text("Your name") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun StartForm(prefs: Prefs, notice: String?, onDone: () -> Unit, onBack: () -> Unit) {
    var server by remember { mutableStateOf(prefs.serverUrl.ifBlank { BuildConfig.DEFAULT_SERVER }) }
    var name by remember { mutableStateOf(prefs.name) }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf(notice) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val submit: () -> Unit = submit@{
        val url = Prefs.normalizeUrl(server)
        if (url.isEmpty()) {
            error = "Enter your server address, like party.example.com."
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
                val resolved = Api.resolveServer(url)
                val token = Api(resolved, "").login(password)
                prefs.serverUrl = resolved
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

    FormCard {
        Text("Start a party", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
        ServerField(server) { server = it }
        NameField(name) { name = it }
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
        OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Back") }
    }
}

/** Viewers join one party with its code (or a pasted invite link, which also fills in the server). */
@Composable
private fun JoinForm(prefs: Prefs, onBack: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val defaultServer = BuildConfig.DEFAULT_SERVER
    var otherServer by remember { mutableStateOf(defaultServer.isBlank()) }
    var server by remember { mutableStateOf(prefs.serverUrl) }
    var code by remember { mutableStateOf("") }
    var name by remember { mutableStateOf(prefs.name) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val submit: () -> Unit = submit@{
        val isLink = code.contains("://") || code.contains("/#/")
        val url = Prefs.normalizeUrl(if (isLink) code else if (otherServer) server else defaultServer)
        val id = Prefs.roomCode(code)
        if (url.isEmpty()) {
            error = "Enter the server address from your host, or paste their invite link."
            return@submit
        }
        if (id.isEmpty()) {
            error = "Enter the party code from your host."
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
                val resolved = Api.resolveServer(url)
                val joined = Api(resolved, "").join(id)
                prefs.serverUrl = resolved
                prefs.token = joined.token.orEmpty()
                prefs.name = name.trim().take(32)
                RoomActivity.start(context, joined.room.id, host = false)
            } catch (e: Exception) {
                error = e.message ?: "Couldn't reach the server."
            } finally {
                busy = false
            }
        }
    }

    FormCard {
        Text("Join a party", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
        if (otherServer) {
            ServerField(server) { server = it }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Server: ${defaultServer.substringAfter("://")}", color = Muted, fontSize = 13.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = { otherServer = true }) { Text("Other server") }
            }
        }
        OutlinedTextField(
            value = code,
            onValueChange = { code = if (it.contains("/")) it else it.uppercase() },
            label = { Text("Party code or invite link") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        NameField(name) { name = it }
        error?.let { Text(it, color = ErrorColor) }
        Button(onClick = submit, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Text(if (busy) "Joining…" else "Join")
        }
        OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Back") }
    }
}

/** The host's home: start a party (shows its code and a Join button), see running parties, or join by code. */
@Composable
private fun HomeScreen(prefs: Prefs, onSignedOut: (String?) -> Unit) {
    val api = remember { Api(prefs.serverUrl, prefs.token) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var rooms by remember { mutableStateOf<List<RoomSummary>>(emptyList()) }
    var started by remember { mutableStateOf<String?>(null) }
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
                    Text("Popcorn Club", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
                    Text("Hosting as ${prefs.name} on ${prefs.serverUrl}", color = Muted, fontSize = 13.sp)
                }
                OutlinedButton(onClick = { onSignedOut(null) }) { Text("Settings") }
            }
        }
        error?.let { item { Text(it, color = ErrorColor) } }

        item {
            val id = started
            if (id == null) {
                Button(
                    onClick = {
                        scope.launch {
                            guard { api.createRoom(null) }?.let { room ->
                                started = room.id
                                rooms = rooms.filter { it.id != room.id } + room
                            }
                        }
                    },
                    modifier = Modifier.padding(top = 8.dp),
                ) { Text("Start a party") }
            } else {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(Panel)
                        .padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("Your party is ready. Share the code, then join and pick something to watch.", color = Muted)
                    Text(id.uppercase(), fontSize = 40.sp, fontWeight = FontWeight.Bold, color = Color.White, letterSpacing = 4.sp)
                    Button(onClick = { RoomActivity.start(context, id) }) { Text("Join party") }
                }
            }
        }

        item { SectionTitle("Watch parties") }
        if (rooms.isEmpty()) {
            item { Text("No parties right now.", color = Muted) }
        }
        items(rooms, key = { "room-" + it.id }) { room ->
            FocusRow(
                title = room.media?.title ?: "Nothing picked yet",
                subtitle = (if (room.members.isEmpty()) "empty" else room.members.map { it.name }.distinct().joinToString(", ")) + " · code ${room.id.uppercase()}",
                action = "Join",
                onClick = { RoomActivity.start(context, room.id) },
            )
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it },
                    label = { Text("Party code or invite link") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                    modifier = Modifier.weight(1f),
                )
                Button(onClick = joinCode) { Text("Join") }
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
