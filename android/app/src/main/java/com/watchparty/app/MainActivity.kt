package com.watchparty.app

import android.app.UiModeManager
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import androidx.compose.material3.TextButton
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.material3.Icon
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.graphics.asImageBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.layout.ContentScale
import androidx.compose.runtime.produceState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.composed
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

// Muted versions of the cheesesoda.com colors, the same as the web app: a dusky plum and a soft amber.
internal val Bg = Color(0xFF18131F)
internal val Panel = Color(0xFF231C2D)
internal val PanelFocused = Color(0xFF31283E)
internal val Accent = Color(0xFFE09A62)
internal val Muted = Color(0xFFB0A6BF)
internal val ErrorColor = Color(0xFFE06666)
/** The muted pink-to-purple sweep from cheesesoda.com, behind the sign-in screens. The home screen is plain plum. */
private val BrandGradient = Brush.linearGradient(listOf(Color(0xFF8A3A5A), Color(0xFF2B2140)))
// What a TV remote is on turns white with dark text and grows a little, as on Google TV. No colored outlines.
internal val FocusFill = Color(0xFFF2EEF7)
internal val OnFocus = Color(0xFF18131F)
internal val OnFocusMuted = Color(0xFF5B5068)

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

    /** Opens Google's QR scanner and follows a TV sign-in code or a party invite, as if it had been tapped. */
    fun scanCode() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { code ->
                val link = Intent(Intent.ACTION_VIEW, Uri.parse(code.rawValue.orEmpty()))
                val pair = pairLinkFrom(link)
                val join = joinLinkFrom(link)
                when {
                    pair != null -> pairLink.value = pair
                    join != null -> joinLink.value = join
                    else -> Toast.makeText(this, "That isn't a Popcorn Club code.", Toast.LENGTH_LONG).show()
                }
            }
            .addOnFailureListener { e ->
                Toast.makeText(this, "Couldn't open the scanner: ${e.message}", Toast.LENGTH_LONG).show()
            }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        pairLink.value = pairLinkFrom(intent)
        joinLink.value = joinLinkFrom(intent)
        setContent {
            PopcornTheme {
                var setUp by remember { mutableStateOf(prefs.isSetUp) }
                var notice by remember { mutableStateOf<String?>(null) }
                val link = pairLink.value
                val invite = joinLink.value
                val home = link == null && invite == null && setUp
                Box(
                    Modifier
                        .fillMaxSize()
                        .then(if (home) Modifier.background(Bg) else Modifier.background(BrandGradient))
                        .safeDrawingPadding(),
                ) {
                    BackHandler(enabled = link != null || invite != null) {
                        pairLink.value = null
                        joinLink.value = null
                    }
                    if (link != null) {
                        PhonePairScreen(prefs, server = link.first, id = link.second, onClose = { pairLink.value = null; setUp = prefs.isSetUp })
                    } else if (invite != null) {
                        JoinForm(prefs, invite = invite, onBack = { joinLink.value = null })
                    } else if (setUp) {
                        Dashboard(
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

/** The app's Material 3 colors (dusky plum and soft amber) and Barlow type, for every Compose screen. */
@Composable
internal fun PopcornTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Accent,
            onPrimary = Bg,
            background = Bg,
            surface = Panel,
            surfaceContainerHigh = Panel,
            onSurfaceVariant = Muted,
            outline = Color(0xFF8A7F9A),
            error = ErrorColor,
        ),
        typography = BrandTypography,
        content = content,
    )
}

/** First screen for anyone who isn't signed in as the host: join with a code, or start a party with the password. */
@Composable
private fun SetupScreen(prefs: Prefs, notice: String?, onDone: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val isTv = remember {
        context.getSystemService(UiModeManager::class.java)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
    }
    var mode by remember { mutableStateOf<String?>(null) }
    // Back from a sign-in screen returns to this first screen instead of leaving the app.
    BackHandler(enabled = mode != null) { mode = null }
    when (mode) {
        "start" -> StartForm(prefs, notice, onDone, onBack = { mode = null })
        "join" -> JoinForm(prefs, onBack = { mode = null })
        "phone" -> TvPairScreen(prefs, onDone, onBack = { mode = null })
        else -> FormCard {
            LogoTitle()
            notice?.let { Text(it, color = ErrorColor) }
            if (isTv) {
                Button(onClick = { mode = "phone" }, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Sign in with your phone") }
                OutlinedButton(onClick = { mode = "join" }, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Type a party code") }
            } else {
                Button(onClick = { mode = "join" }, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Join a party") }
                OutlinedButton(onClick = { (context as? MainActivity)?.scanCode() }, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Scan a TV or invite code") }
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
        // A link on the invite domain (tv.chzsda.com) only forwards; the party itself is on the default server.
        val onInviteHost = isLink && runCatching { Uri.parse(code.trim()).host }.getOrNull().equals(BuildConfig.INVITE_HOST, ignoreCase = true)
        val url = Prefs.normalizeUrl(if (isLink && !onInviteHost) code else if (otherServer && !onInviteHost) server else defaultServer)
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
                // The only button here, so it needs no focus ring.
                OutlinedButton(onClick = onBack) { Text("Back") }
            }
        }
    }
}

/** Opened on a phone from a TV's QR code: choose what the TV signs in as. */
@Composable
private fun PhonePairScreen(prefs: Prefs, server: String, id: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    // Same server however the address is written (case, a trailing slash), so a signed-in host isn't asked for the password.
    val signedInHost = prefs.isSetUp && Prefs.normalizeUrl(prefs.serverUrl).equals(Prefs.normalizeUrl(server), ignoreCase = true)
    val api = remember { Api(server, if (signedInHost) prefs.token else "") }
    val scope = rememberCoroutineScope()
    var asHost by remember { mutableStateOf(false) }
    // The party this phone was last in, so joining the TV to it is one tap. Filled in only once the server
    // says it's still running, so an ended party's code never shows.
    var code by remember { mutableStateOf("") }
    var checkingLast by remember { mutableStateOf(prefs.lastRoom.isNotEmpty()) }
    var password by remember { mutableStateOf("") }
    var name by remember { mutableStateOf(prefs.name) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf(false) }
    /** The party the TV joined with a code, so this phone can join it too without typing it again. */
    var tvParty by remember { mutableStateOf<String?>(null) }

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
                // The password just signed in the TV, so it signs in this phone as the host too.
                if (asHost && !signedInHost) {
                    try {
                        prefs.token = api.login(password)
                        prefs.serverUrl = server
                        if (prefs.name.isBlank()) prefs.name = name.trim().take(32)
                        prefs.markSignedIn(true)
                    } catch (_: Exception) {
                        // The TV is signed in either way; the phone can still sign in by itself later.
                    }
                }
                tvParty = if (asHost) null else Prefs.roomCode(code)
                done = true
            } catch (e: Exception) {
                error = e.message ?: "Couldn't reach the server."
            } finally {
                busy = false
            }
        }
    }

    // Joins the TV's party here under the TV's name, so this phone becomes the chat and voice screen.
    val joinHere: () -> Unit = joinHere@{
        val party = tvParty ?: return@joinHere
        busy = true
        error = null
        scope.launch {
            try {
                val joined = api.join(party)
                prefs.serverUrl = server
                // A host's phone keeps its host sign-in; anyone else's gets the party's guest pass.
                if (!signedInHost) prefs.token = joined.token.orEmpty()
                prefs.name = name.trim().take(32)
                prefs.lastRoom = joined.room.id
                RoomActivity.start(context, joined.room.id, host = signedInHost)
                onClose()
            } catch (e: Exception) {
                error = e.message ?: "Couldn't reach the server."
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(Unit) {
        val last = prefs.lastRoom
        if (last.isEmpty()) return@LaunchedEffect
        val sameServer = Prefs.normalizeUrl(prefs.serverUrl) == Prefs.normalizeUrl(server)
        val live = sameServer && withTimeoutOrNull(3_000) {
            try {
                Api(server, prefs.token).room(last)
                true
            } catch (e: Exception) {
                false
            }
        } == true
        if (live) code = last.uppercase() else prefs.lastRoom = ""
        checkingLast = false
    }

    if (checkingLast) {
        FormCard { Text("Checking your last party…", color = Muted) }
        return
    }

    if (done) {
        FormCard {
            Text("All set", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
            if (tvParty != null) {
                Text("Your TV is joining the party. Join on this phone too to chat and talk while you watch on the TV.", color = Muted)
                error?.let { Text(it, color = ErrorColor) }
                Button(onClick = joinHere, enabled = !busy, modifier = Modifier.focusRing().fillMaxWidth()) {
                    Text(if (busy) "Joining…" else "Join on this phone too")
                }
                OutlinedButton(onClick = onClose, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Done") }
            } else {
                Text("Your TV is signing in now.", color = Muted)
                Button(onClick = onClose, modifier = Modifier.focusRing().fillMaxWidth()) { Text("Done") }
            }
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

internal fun qrBitmap(text: String, size: Int = 480): ImageBitmap {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 0))
    val pixels = IntArray(size * size) { i -> if (matrix[i % size, i / size]) android.graphics.Color.BLACK else android.graphics.Color.WHITE }
    return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888).asImageBitmap()
}

/** A TMDB poster or still loaded through the server, or an empty frame the same size while it loads or if there's none. */
@Composable
private fun Poster(api: Api, path: String?, size: String, width: Dp, height: Dp) {
    val image by produceState<ImageBitmap?>(null, path, size) { value = path?.let { api.image(it, size) } }
    val shape = RoundedCornerShape(6.dp)
    val frame = Modifier.width(width).height(height).clip(shape).background(PanelFocused)
    image?.let { Image(it, contentDescription = null, contentScale = ContentScale.Crop, modifier = frame) } ?: Box(frame)
}

/** A video's details: poster, title, summary, and Start party (plus Binge from here for an episode). */
@Composable
internal fun DetailsDialog(
    api: Api,
    media: MediaItem,
    length: String,
    credit: Boolean,
    onStart: () -> Unit,
    onBingeFrom: (() -> Unit)?,
    onClose: () -> Unit,
    startLabel: String = "Start party",
    /** Adding to a party's Up next: Add to Up next comes first, so a remote picks several with OK in a row. */
    onQueue: (() -> Unit)? = null,
    queued: Boolean = false,
    /** "34 m left" after the length, in orange, for a video stopped partway. */
    left: String? = null,
    /** Mark as watched / Mark as not watched; null hides the button. */
    onMark: (() -> Unit)? = null,
    watched: Boolean = false,
) {
    val m = media.meta
    val ep = media.episode
    val start = remember { FocusRequester() }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        BoxWithConstraints(Modifier.padding(16.dp).widthIn(max = 720.dp)) {
            val wide = maxWidth >= 520.dp
            Column(
                Modifier
                    .clip(RoundedCornerShape(16.dp))
                    .background(Panel)
                    .border(1.dp, Muted.copy(alpha = 0.2f), RoundedCornerShape(16.dp))
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                val text: @Composable () -> Unit = {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            (if (ep != null) m?.show ?: ep.show else m?.title ?: media.title) + ((m?.year ?: media.year)?.let { "  $it" } ?: ""),
                            color = Color.White,
                            fontFamily = BarlowCondensed,
                            fontWeight = FontWeight.Bold,
                            fontSize = 28.sp,
                            lineHeight = 30.sp,
                        )
                        if (ep != null) {
                            Text(
                                "Season ${ep.season}, episode ${ep.episode}" + (ep.title?.let { " · $it" } ?: ""),
                                color = Color.White,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        Text(
                            buildAnnotatedString {
                                append(length)
                                if (left != null) withStyle(SpanStyle(color = Accent)) { append((if (length.isNotEmpty()) " · " else "") + left) }
                            },
                            color = Muted,
                            fontSize = 13.sp,
                        )
                        m?.overview?.let { Text(it, color = Color.White.copy(alpha = 0.9f), fontSize = 15.sp, modifier = Modifier.padding(top = 4.dp)) }
                    }
                }
                val poster = m?.posterPath ?: m?.stillPath
                if (wide && poster != null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                        Poster(api, poster, "w342", 140.dp, 210.dp)
                        Box(Modifier.weight(1f)) { text() }
                    }
                } else {
                    if (poster != null) Poster(api, poster, "w342", 100.dp, 150.dp)
                    text()
                }
                FlowRowButtons {
                    if (onQueue != null) {
                        // Cancel, Play for everyone, Add to Up next (as in ui-redesign/queue/tv-add-episode).
                        OutlinedButton(onClick = onClose, modifier = Modifier.focusRing()) { Text("Cancel") }
                        OutlinedButton(onClick = onStart, modifier = Modifier.focusRing().then(if (queued) Modifier.focusRequester(start) else Modifier)) { Text(startLabel) }
                        Button(onClick = onQueue, enabled = !queued, modifier = Modifier.focusRing().then(if (queued) Modifier else Modifier.focusRequester(start))) {
                            Text(if (queued) "In Up next" else "Add to Up next")
                        }
                    } else {
                        Button(onClick = onStart, modifier = Modifier.focusRing().focusRequester(start)) { Text(startLabel) }
                        onBingeFrom?.let { OutlinedButton(onClick = it, modifier = Modifier.focusRing()) { Text("Binge from here") } }
                        onMark?.let {
                            OutlinedButton(onClick = it, modifier = Modifier.focusRing()) {
                                if (!watched) Icon(painterResource(R.drawable.ic_check), contentDescription = null, modifier = Modifier.padding(end = 8.dp).size(18.dp))
                                Text(if (watched) "Mark as not watched" else "Mark as watched")
                            }
                        }
                        OutlinedButton(onClick = onClose, modifier = Modifier.focusRing()) { Text("Close") }
                    }
                }
                if (credit) {
                    Text(
                        "Details and images from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.",
                        color = Muted,
                        fontSize = 12.sp,
                    )
                }
            }
        }
    }
    // A TV remote lands on Start party.
    LaunchedEffect(media.id) { runCatching { start.requestFocus() } }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowButtons(content: @Composable () -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
}

/** Material's buttons, except the one a TV remote is on turns white with dark text (with [focusRing]'s zoom). */
@Composable
internal fun Button(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable RowScope.() -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    androidx.compose.material3.Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        interactionSource = interaction,
        colors = ButtonDefaults.buttonColors(containerColor = if (focused) FocusFill else Accent, contentColor = OnFocus),
        content = content,
    )
}

@Composable
internal fun OutlinedButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable RowScope.() -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    androidx.compose.material3.OutlinedButton(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        interactionSource = interaction,
        colors = if (focused) ButtonDefaults.outlinedButtonColors(containerColor = FocusFill, contentColor = OnFocus) else ButtonDefaults.outlinedButtonColors(),
        border = if (focused) null else ButtonDefaults.outlinedButtonBorder(enabled),
        content = content,
    )
}

@Composable
private fun TextButton(onClick: () -> Unit, modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    androidx.compose.material3.TextButton(
        onClick = onClick,
        modifier = modifier,
        interactionSource = interaction,
        colors = if (focused) ButtonDefaults.textButtonColors(containerColor = FocusFill, contentColor = OnFocus) else ButtonDefaults.textButtonColors(),
        content = content,
    )
}

/**
 * A slight zoom on the button a TV remote has selected (the buttons above also turn white). Material's own focus tint is too faint
 * to see from the couch. Touch doesn't focus buttons, so phones never show it.
 */
internal fun Modifier.focusRing(): Modifier = composed {
    var focused by remember { mutableStateOf(false) }
    this
        .onFocusChanged { focused = it.isFocused }
        .scale(if (focused) 1.06f else 1f)
        // Material pads a 40 dp button out to a 48 dp touch target; making the button itself 48 dp tall
        // keeps the white fill the same size as the button's touch area.
        .heightIn(min = 48.dp)
}

/** Dialog colors, the same as the player's dialogs. */
internal val DialogSurface = PanelFocused
internal val DangerText = Color(0xFFF2A08E)

/**
 * A Material 3 dialog's text button: a pill that turns white with dark text while a remote is on it, like every
 * other focused control. [danger] (warm red) is for actions that affect everyone, such as ending a party.
 */
@Composable
internal fun DialogButton(label: String, danger: Boolean = false, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    TextButton(
        onClick = onClick,
        interactionSource = interaction,
        shape = RoundedCornerShape(20.dp),
        colors = ButtonDefaults.textButtonColors(
            containerColor = if (focused) FocusFill else Color.Transparent,
            contentColor = if (focused) OnFocus else if (danger) DangerText else Accent,
        ),
        modifier = modifier.focusRing(),
    ) { Text(label, fontWeight = FontWeight.SemiBold) }
}

internal fun clock(seconds: Double): String {
    val s = seconds.toLong().coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) String.format("%d:%02d:%02d", h, m, sec) else String.format("%d:%02d", m, sec)
}
