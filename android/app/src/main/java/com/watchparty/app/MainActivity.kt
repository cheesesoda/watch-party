package com.watchparty.app

import android.app.UiModeManager
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.Bundle
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.composed
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val Bg = Color(0xFF0F1115)
private val Panel = Color(0xFF181B22)
private val Accent = Color(0xFFE5A00D)
private val Muted = Color(0xFF9097A6)
private val ErrorColor = Color(0xFFFF7A6B)

class MainActivity : ComponentActivity() {
    /** A TV sign-in link (server, pairing id) this phone was opened with, from the TV's QR code. */
    private val pairLink = mutableStateOf<Pair<String, String>?>(null)
    /** A party invite link (https://host/join/CODE) this app was opened with. */
    private val joinLink = mutableStateOf<String?>(null)

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pairLinkFrom(intent)?.let { pairLink.value = it }
        joinLinkFrom(intent)?.let { joinLink.value = it }
    }

    private fun joinLinkFrom(intent: Intent?): String? {
        val uri = intent?.data ?: return null
        return uri.toString().takeIf { uri.pathSegments.size == 2 && uri.pathSegments[0] == "join" }
    }

    private fun pairLinkFrom(intent: Intent?): Pair<String, String>? {
        val uri = intent?.data ?: return null
        val id = uri.pathSegments.takeIf { it.size == 2 && it[0] == "pair" }?.get(1) ?: return null
        val port = if (uri.port > 0) ":${uri.port}" else ""
        return "${uri.scheme}://${uri.host}$port" to id
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        pairLink.value = pairLinkFrom(intent)
        joinLink.value = joinLinkFrom(intent)
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
                    val link = pairLink.value
                    val invite = joinLink.value
                    if (link != null) {
                        PhonePairScreen(prefs, server = link.first, id = link.second, onClose = { pairLink.value = null })
                    } else if (invite != null) {
                        JoinForm(prefs, invite = invite, onBack = { joinLink.value = null })
                    } else if (setUp) {
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
    val context = androidx.compose.ui.platform.LocalContext.current
    val isTv = remember {
        context.getSystemService(UiModeManager::class.java)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
    }
    var mode by remember { mutableStateOf<String?>(null) }
    when (mode) {
        "start" -> StartForm(prefs, notice, onDone, onBack = { mode = null })
        "join" -> JoinForm(prefs, onBack = { mode = null })
        "phone" -> TvPairScreen(prefs, onDone, onBack = { mode = null })
        else -> FormCard {
            Text("Popcorn Club", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
            notice?.let { Text(it, color = ErrorColor) }
            if (isTv) {
                Button(onClick = { mode = "phone" }, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Sign in with your phone") }
                OutlinedButton(onClick = { mode = "join" }, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Type a party code") }
            } else {
                Button(onClick = { mode = "join" }, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Join a party") }
            }
            OutlinedButton(onClick = { mode = "start" }, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Start a party") }
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

/** The built-in server, with an "Other server" escape hatch that shows the address field. */
@Composable
private fun ServerChoice(other: Boolean, defaultServer: String, server: String, onOther: () -> Unit, onChange: (String) -> Unit) {
    if (other) {
        ServerField(server, onChange)
    } else {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Server: ${defaultServer.substringAfter("://")}", color = Muted, fontSize = 13.sp, modifier = Modifier.weight(1f))
            TextButton(onClick = onOther, modifier = Modifier.focusRing()) { Text("Other server") }
        }
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
    val defaultServer = BuildConfig.DEFAULT_SERVER
    var otherServer by remember { mutableStateOf(defaultServer.isBlank()) }
    var server by remember { mutableStateOf(prefs.serverUrl) }
    var name by remember { mutableStateOf(prefs.name) }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf(notice) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val submit: () -> Unit = submit@{
        val url = Prefs.normalizeUrl(if (otherServer) server else defaultServer)
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
        ServerChoice(otherServer, defaultServer, server, onOther = { otherServer = true }) { server = it }
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
        Button(onClick = submit, enabled = !busy, modifier = Modifier.focusRing().fillMaxWidth()) {
            Text(if (busy) "Connecting…" else "Continue")
        }
        OutlinedButton(onClick = onBack, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Back") }
    }
}

/** Viewers join one party with its code (or a pasted invite link, which also fills in the server). */
@Composable
private fun JoinForm(prefs: Prefs, invite: String = "", onBack: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val defaultServer = BuildConfig.DEFAULT_SERVER
    var otherServer by remember { mutableStateOf(defaultServer.isBlank()) }
    var server by remember { mutableStateOf(prefs.serverUrl) }
    var code by remember { mutableStateOf(invite) }
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
                prefs.lastRoom = joined.room.id
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
        ServerChoice(otherServer, defaultServer, server, onOther = { otherServer = true }) { server = it }
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
        Button(onClick = submit, enabled = !busy, modifier = Modifier.focusRing().fillMaxWidth()) {
            Text(if (busy) "Joining…" else "Join")
        }
        OutlinedButton(onClick = onBack, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Back") }
    }
}

/**
 * On a TV: shows a QR code. A phone scans it, enters a party code (or the password), and this screen picks up
 * the sign-in and joins the party (or opens the host's home).
 */
@Composable
private fun TvPairScreen(prefs: Prefs, onDone: () -> Unit, onBack: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var qr by remember { mutableStateOf<ImageBitmap?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        val server = try {
            Api.resolveServer(Prefs.normalizeUrl(BuildConfig.DEFAULT_SERVER.ifBlank { prefs.serverUrl }))
        } catch (e: Exception) {
            error = e.message ?: "Couldn't reach the server."
            return@LaunchedEffect
        }
        val api = Api(server, "")
        while (true) {
            val pairing = try {
                api.createPairing()
            } catch (e: Exception) {
                error = e.message ?: "Couldn't reach the server."
                delay(5000)
                continue
            }
            qr = qrBitmap(api.pairUrl(pairing.id))
            error = null
            // Poll until the phone finishes or the code expires, then start over with a fresh code.
            while (true) {
                delay(2000)
                val status = try {
                    api.pairStatus(pairing.id)
                } catch (e: ApiException) {
                    break
                } catch (e: Exception) {
                    continue
                }
                if (status.status != "done" || status.token == null) continue
                prefs.serverUrl = server
                prefs.token = status.token
                status.name?.let { prefs.name = it }
                if (status.role == "host") {
                    prefs.markSignedIn(true)
                    onDone()
                } else if (status.room != null) {
                    RoomActivity.start(context, status.room, host = false)
                    onBack()
                }
                return@LaunchedEffect
            }
        }
    }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Row(
            Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(Panel)
                .padding(32.dp),
            horizontalArrangement = Arrangement.spacedBy(32.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(260.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color.White),
                contentAlignment = Alignment.Center,
            ) {
                qr?.let { Image(it, contentDescription = "Sign-in QR code", modifier = Modifier.size(240.dp)) }
                    ?: Text("Loading…", color = Bg)
            }
            Column(Modifier.widthIn(max = 360.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Sign in with your phone", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
                Text("Scan the code with your phone's camera, then enter the party code and a name. The TV joins on its own.", color = Muted)
                error?.let { Text(it, color = ErrorColor) }
                OutlinedButton(onClick = onBack, modifier = Modifier.focusRing()) { Text("Back") }
            }
        }
    }
}

/** Opened on a phone from a TV's QR code: choose what the TV signs in as. */
@Composable
private fun PhonePairScreen(prefs: Prefs, server: String, id: String, onClose: () -> Unit) {
    val signedInHost = prefs.isSetUp && prefs.serverUrl == server
    val api = remember { Api(server, if (signedInHost) prefs.token else "") }
    val scope = rememberCoroutineScope()
    var asHost by remember { mutableStateOf(false) }
    // The party this phone was last in, so joining the TV to it is one tap.
    var code by remember { mutableStateOf(prefs.lastRoom.uppercase()) }
    var password by remember { mutableStateOf("") }
    var name by remember { mutableStateOf(prefs.name) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf(false) }

    val submit: () -> Unit = submit@{
        if (!asHost && code.isBlank()) {
            error = "Enter the party code from your host."
            return@submit
        }
        if (name.isBlank()) {
            error = "Pick a name for the TV so friends know who's watching."
            return@submit
        }
        busy = true
        error = null
        scope.launch {
            try {
                api.completePairing(
                    id,
                    name.trim().take(32),
                    code = if (asHost) null else Prefs.roomCode(code),
                    password = if (asHost && !signedInHost) password else null,
                )
                done = true
            } catch (e: Exception) {
                error = e.message ?: "Couldn't reach the server."
            } finally {
                busy = false
            }
        }
    }

    if (done) {
        FormCard {
            Text("All set", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
            Text("Your TV is signing in now.", color = Muted)
            Button(onClick = onClose, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Done") }
        }
        return
    }

    FormCard {
        Text("Sign in your TV", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
        if (!asHost) {
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.uppercase() },
                label = { Text("Party code") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
        } else if (!signedInHost) {
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Server password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        OutlinedTextField(
            value = name,
            onValueChange = { name = it.take(32) },
            label = { Text("Name on the TV") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Keep your own name: when the TV joins under it, this phone switches to chat only.", color = Muted, fontSize = 13.sp)
        error?.let { Text(it, color = ErrorColor) }
        Button(onClick = submit, enabled = !busy, modifier = Modifier.focusRing().fillMaxWidth()) {
            Text(if (busy) "Signing in…" else if (asHost) "Sign in TV as host" else "Join on the TV")
        }
        OutlinedButton(onClick = { asHost = !asHost }, modifier = Modifier.focusRing().fillMaxWidth()) {
            Text(if (asHost) "Join a party instead" else "I'm the host")
        }
        TextButton(onClick = onClose, modifier = Modifier.focusRing()) { Text("Cancel") }
    }
}

private fun qrBitmap(text: String, size: Int = 480): ImageBitmap {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 0))
    val pixels = IntArray(size * size) { i -> if (matrix[i % size, i / size]) android.graphics.Color.BLACK else android.graphics.Color.WHITE }
    return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888).asImageBitmap()
}

/** The host's home: start a party (shows its code and a Join button), see running parties, or join by code. */
@Composable
private fun HomeScreen(prefs: Prefs, onSignedOut: (String?) -> Unit) {
    val api = remember { Api(prefs.serverUrl, prefs.token) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var rooms by remember { mutableStateOf<List<RoomSummary>>(emptyList()) }
    var started by remember { mutableStateOf<RoomSummary?>(null) }
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

    val listState = rememberLazyListState()
    LazyColumn(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp),
        state = listState,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Row(Modifier.padding(top = 20.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Popcorn Club", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
                    Text("Hosting as ${prefs.name} on ${prefs.serverUrl}", color = Muted, fontSize = 13.sp)
                }
                OutlinedButton(onClick = { onSignedOut(null) }, modifier = Modifier.focusRing()) { Text("Settings") }
            }
        }
        error?.let { item { Text(it, color = ErrorColor) } }

        started?.let { room ->
            item(key = "started") {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(Panel)
                        .padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("Party ready for ${room.media?.title ?: "your movie"}. Share the code, then join when you're ready to watch.", color = Muted)
                    Text(room.id.uppercase(), fontSize = 40.sp, fontWeight = FontWeight.Bold, color = Color.White, letterSpacing = 4.sp)
                    Button(onClick = { RoomActivity.start(context, room.id) }, modifier = Modifier.focusRing()) { Text("Join party") }
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
                Button(onClick = joinCode, modifier = Modifier.focusRing()) { Text("Join") }
            }
        }
        item { SectionTitle("Start a party") }
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
                }, modifier = Modifier.focusRing()) { Text("Refresh") }
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
                                guard { api.createRoom(media.id) }?.let { room ->
                                    started = room
                                    rooms = rooms.filter { it.id != room.id } + room
                                    listState.animateScrollToItem(0)
                                }
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

/**
 * A white ring and a slight zoom on the button a TV remote has selected. Material's own focus tint is too faint
 * to see from the couch. Touch doesn't focus buttons, so phones never show it.
 */
private fun Modifier.focusRing(): Modifier = composed {
    var focused by remember { mutableStateOf(false) }
    this
        .onFocusChanged { focused = it.isFocused }
        .scale(if (focused) 1.06f else 1f)
        .border(3.dp, if (focused) Color.White else Color.Transparent, RoundedCornerShape(50))
        // Material pads a 40 dp button out to a 48 dp touch target, which left a gap between the ring and the
        // button. Making the button itself 48 dp tall removes the padding, so the ring sits on its edge.
        .heightIn(min = 48.dp)
}

private fun formatSize(bytes: Long): String {
    val gb = bytes / (1024.0 * 1024 * 1024)
    return if (gb >= 1) String.format("%.1f GB", gb) else "${maxOf(1, bytes / (1024 * 1024))} MB"
}
