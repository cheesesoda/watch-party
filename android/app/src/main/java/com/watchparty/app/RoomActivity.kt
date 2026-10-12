package com.watchparty.app

import android.Manifest
import android.app.AlertDialog
import android.app.UiModeManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.StateListDrawable
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import android.text.TextUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.DefaultTimeBar
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.launch
import androidx.media3.common.MediaItem as ExoMediaItem

/** Full-screen player for one watch party, with a chat overlay. Works with touch and a TV remote. */
@OptIn(UnstableApi::class)
class RoomActivity : ComponentActivity() {

    private lateinit var prefs: Prefs
    private lateinit var api: Api
    private lateinit var player: ExoPlayer
    private lateinit var sync: PlayerSync
    private lateinit var connection: RoomConnection

    private lateinit var playerView: PlayerView
    private lateinit var topBar: LinearLayout
    private lateinit var titleText: TextView
    private lateinit var membersText: TextView
    private lateinit var statusText: TextView
    private lateinit var chatOverlay: LinearLayout
    private lateinit var voiceButton: Button
    private lateinit var muteButton: Button
    private lateinit var voiceStrip: TextView
    private lateinit var chatPanel: LinearLayout
    private lateinit var chatPanelHistory: LinearLayout
    private lateinit var chatPanelInput: EditText
    private lateinit var companionView: LinearLayout
    private lateinit var companionTitle: TextView
    private lateinit var companionVoice: TextView
    private lateinit var companionHistory: LinearLayout
    private lateinit var companionVoiceButton: Button
    private lateinit var companionMuteButton: Button

    private val main = Handler(Looper.getMainLooper())
    private val chat = mutableListOf<ChatMessage>()
    private var me: Member? = null
    private var loadedMediaId: String? = null
    private var isTv = false
    private var lastState: PlaybackState? = null
    private var lastMedia: MediaItem? = null
    /** Codecs of the loaded file, once the server says. */
    private var mediaInfo: MediaInfo? = null
    /** Playing the server's converted copy instead of the original file. */
    private var converted = false

    /** Phone showing only chat, because its owner is watching on a TV. */
    private var companion = false
    private var autoSwitched = false
    private var ended = false
    /** False for viewers who joined with the party code: no Change video, no End party. */
    private var host = true
    private var roomCode = ""

    /** Back outside the chat asks first, so one press too many doesn't drop you out of the party. */
    private val confirmLeaveOnBack = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() = confirmLeave()
    }

    /** While the playback controls are showing, Back just hides them. */
    private val hideControlsOnBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            playerView.hideController()
            playerView.requestFocus()
        }
    }

    private val closeChatOnBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = closeChat()
    }

    private var members: List<Member> = emptyList()
    /** The binge, if the party has one. */
    private var queue: Queue? = null
    private var upNext: AlertDialog? = null
    private lateinit var prevButton: Button
    private lateinit var nextButton: Button
    private var iceServers: List<IceServer> = emptyList()
    private var voice: VoiceChat? = null
    private var muted = false
    private var speaking: Set<String> = emptySet()
    private val brokenVoice = mutableSetOf<String>()

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        startVoice(withMic = granted)
    }

    private val chatTicker = object : Runnable {
        override fun run() {
            renderChatOverlay()
            main.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        api = Api(prefs.serverUrl, prefs.token)
        val roomId = intent.getStringExtra(EXTRA_ROOM) ?: return finish()
        host = intent.getBooleanExtra(EXTRA_HOST, true)
        roomCode = roomId.uppercase()
        isTv = getSystemService(UiModeManager::class.java)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
        // Added last wins: an open chat closes first, then showing controls hide, otherwise Back asks before leaving.
        onBackPressedDispatcher.addCallback(this, confirmLeaveOnBack)
        onBackPressedDispatcher.addCallback(this, hideControlsOnBack)
        onBackPressedDispatcher.addCallback(this, closeChatOnBack)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        // The token goes in a header too: HLS segment links can't carry it in the URL.
        val http = DefaultHttpDataSource.Factory().setDefaultRequestProperties(api.authHeaders())
        player = ExoPlayer.Builder(this).setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(http)).build()
        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                if (!switchToConverted()) Toast.makeText(this@RoomActivity, "Can't play this video: ${error.errorCodeName}", Toast.LENGTH_LONG).show()
            }

            // In a binge, the server moves everyone on to the next video once a screen reports the end.
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) loadedMediaId?.let { connection.send(Protocol.ended(it)) }
            }

            // A sound or picture track this device can't decode is skipped silently, so check for that too.
            override fun onTracksChanged(tracks: Tracks) {
                val unplayable = listOf(C.TRACK_TYPE_AUDIO, C.TRACK_TYPE_VIDEO).any { type ->
                    val groups = tracks.groups.filter { it.type == type }
                    groups.isNotEmpty() && groups.none { it.isSupported }
                }
                if (unplayable) switchToConverted()
            }
        })
        sync = PlayerSync(player) { type, position -> connection.send(Protocol.position(type, position)) }
        buildLayout()
        playerView.player = player

        connection = RoomConnection(
            api.socketUrl(roomId, prefs.name, if (isTv) "tv" else "phone"),
            onMessage = ::onServerMessage,
            onStatus = ::onStatus,
        )
        connection.connect()
    }

    override fun onStart() {
        super.onStart()
        if (!companion) sync.start()
        main.post(chatTicker)
        if (!companion) playerView.requestFocus()
    }

    override fun onStop() {
        // Android doesn't let a backgrounded app keep the mic, so leave voice when the player goes away.
        stopVoice()
        // Stop listening first so pausing here isn't broadcast as "paused" to everyone.
        sync.stop()
        player.playWhenReady = false
        main.removeCallbacks(chatTicker)
        super.onStop()
    }

    override fun onDestroy() {
        stopVoice()
        if (::connection.isInitialized) connection.close()
        if (::player.isInitialized) player.release()
        super.onDestroy()
    }

    /**
     * Play, pause and skip buttons on a TV remote. Handled here, before any view, because the player view
     * only sees them while it has focus, and nothing else picks them up since the app has no media session.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (companion || !isMediaKey(event.keyCode)) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> player.playWhenReady = !player.playWhenReady
                KeyEvent.KEYCODE_MEDIA_PLAY -> player.playWhenReady = true
                KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_STOP -> player.playWhenReady = false
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> player.seekTo(player.currentPosition + SKIP_MS)
                KeyEvent.KEYCODE_MEDIA_REWIND -> player.seekTo(maxOf(0L, player.currentPosition - SKIP_MS))
                KeyEvent.KEYCODE_MEDIA_NEXT -> bingeStep(1)?.let { playForEveryone(it) }
                KeyEvent.KEYCODE_MEDIA_PREVIOUS -> bingeStep(-1)?.let { playForEveryone(it) }
            }
        }
        return true
    }

    private fun isMediaKey(keyCode: Int): Boolean = keyCode in setOf(
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK, KeyEvent.KEYCODE_MEDIA_PLAY,
        KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_STOP, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
        KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_PREVIOUS,
    )

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_BUTTON_Y, KeyEvent.KEYCODE_PROG_BLUE -> {
                if (!companion) {
                    if (chatPanel.visibility == View.VISIBLE) closeChat() else openChat()
                }
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    // --- server events ---

    private fun onServerMessage(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.Welcome -> {
                me = msg.you
                iceServers = msg.iceServers
                voice?.rejoin(msg.you.id)
                chat.clear()
                chat.addAll(msg.chat)
                showMembers(msg.members)
                applyState(msg.state, msg.media)
                setQueue(msg.queue)
                renderChat()
            }
            is ServerMessage.QueueChanged -> setQueue(msg.queue)
            is ServerMessage.State -> applyState(msg.state, msg.media)
            is ServerMessage.Members -> {
                voice?.syncMembers(msg.members)
                showMembers(msg.members)
            }
            is ServerMessage.Chat -> {
                chat.add(msg.message)
                if (chat.size > 200) chat.removeAt(0)
                renderChat()
            }
            is ServerMessage.Pong -> sync.clock.onPong(msg.clientTime, msg.serverTime, System.currentTimeMillis())
            is ServerMessage.Error -> Toast.makeText(this, msg.message, Toast.LENGTH_SHORT).show()
            is ServerMessage.VoicePeers -> voice?.callAll(msg.peers)
            is ServerMessage.Signal -> voice?.onSignal(msg.from, msg.data)
            is ServerMessage.Ended -> {
                ended = true
                val who = msg.by.ifBlank { "Someone" }
                Toast.makeText(this, "$who ended the watch party.", Toast.LENGTH_LONG).show()
                finish()
            }
        }
    }

    private fun onStatus(status: RoomConnection.Status) {
        when (status) {
            RoomConnection.Status.OPEN -> statusText.visibility = View.GONE
            RoomConnection.Status.CONNECTING -> showStatus("Connecting…")
            RoomConnection.Status.RECONNECTING -> showStatus("Reconnecting…")
            RoomConnection.Status.ROOM_GONE -> {
                if (ended) return
                Toast.makeText(this, "This watch party has ended.", Toast.LENGTH_LONG).show()
                finish()
            }
            RoomConnection.Status.UNAUTHORIZED -> {
                prefs.markSignedIn(false)
                Toast.makeText(this, "Signed out. Check the server password.", Toast.LENGTH_LONG).show()
                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                finish()
            }
        }
    }

    private fun applyState(state: PlaybackState, media: MediaItem?) {
        lastState = state
        lastMedia = media
        titleText.text = media?.title
            ?: if (host) "Nothing playing. Use Change video to pick something. Friends join with code $roomCode."
            else "Waiting for the host to pick something."
        companionTitle.text = media?.title ?: "Nothing playing"
        updateBingeButtons()
        if (::membersText.isInitialized) showMembers(members)
        if (companion) return
        if (media != null && media.id != loadedMediaId) {
            loadedMediaId = media.id
            converted = false
            mediaInfo = null
            lifecycleScope.launch {
                val info = runCatching { api.info(media.id) }.getOrNull()
                if (loadedMediaId != media.id) return@launch
                mediaInfo = info
                val metered = getSystemService(ConnectivityManager::class.java)?.isActiveNetworkMetered == true
                val direct = info == null || Playable.direct(info, media.size, isTv, metered, DeviceDecoders(this@RoomActivity))
                load(media, converted = !direct)
            }
        }
        sync.setState(state)
    }

    /** Plays [media], either the original file or the server's converted copy. */
    private fun load(media: MediaItem, converted: Boolean) {
        this.converted = converted
        val subs = media.subtitles.map { track ->
            ExoMediaItem.SubtitleConfiguration.Builder(Uri.parse(api.subtitleUrl(media.id, track.index)))
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(track.lang)
                .setLabel(track.label)
                .setSelectionFlags(if (track.index == 0) C.SELECTION_FLAG_DEFAULT else 0)
                .build()
        }
        val item = ExoMediaItem.Builder()
            .setUri(if (converted) api.hlsUrl(media.id) else api.streamUrl(media.id))
            .setMimeType(if (converted) MimeTypes.APPLICATION_M3U8 else null)
            .setMediaId(media.id)
            .setSubtitleConfigurations(subs)
            .build()
        player.setMediaItem(item)
        player.prepare()
    }

    /** When the original file won't play here, switches to the converted copy. False if that isn't possible. */
    private fun switchToConverted(): Boolean {
        val media = lastMedia
        if (converted || mediaInfo?.convert != true || media == null || media.id != loadedMediaId) return false
        Toast.makeText(this, "This device can't play the original file. Switching to a converted copy.", Toast.LENGTH_LONG).show()
        load(media, converted = true)
        return true
    }

    // --- UI ---

    private fun buildLayout() {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        playerView = PlayerView(this).apply {
            useController = true
            controllerShowTimeoutMs = 4000
            setShowSubtitleButton(true)
            keepScreenOn = true
            setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { visibility ->
                topBar.visibility = visibility
                hideControlsOnBack.isEnabled = visibility == View.VISIBLE
            })
        }
        highlightControlFocus()
        root.addView(playerView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(24), dp(16), dp(16), dp(32))
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.argb(210, 0, 0, 0), Color.TRANSPARENT),
            )
        }
        val titles = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        titleText = text(20f, ON_SURFACE).apply { typeface = MEDIUM; maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        membersText = text(13f, ON_SURFACE_VARIANT).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        titles.addView(titleText)
        titles.addView(membersText)
        topBar.addView(titles, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        // TVs show icon and label; phones show icons (long-press for the name) so the bar fits.
        val iconOnly = !isTv
        topBar.addView(barButton("Chat", R.drawable.ic_chat, iconOnly) { openChat() })
        // Previous and next in a binge, only while there is one.
        prevButton = barButton("Previous", R.drawable.ic_skip_previous, iconOnly) { bingeStep(-1)?.let { playForEveryone(it) } }.apply { visibility = View.GONE }
        nextButton = barButton("Next", R.drawable.ic_skip_next, iconOnly) { bingeStep(1)?.let { playForEveryone(it) } }.apply { visibility = View.GONE }
        if (host) {
            topBar.addView(prevButton)
            topBar.addView(nextButton)
            topBar.addView(barButton("Change video", R.drawable.ic_video, iconOnly) { pickVideo() })
        }
        voiceButton = barButton("Join voice", R.drawable.ic_mic, iconOnly) { toggleVoice() }
        topBar.addView(voiceButton)
        muteButton = barButton("Mute", R.drawable.ic_mic_off, iconOnly) { toggleMute() }.apply { visibility = View.GONE }
        topBar.addView(muteButton)
        if (!isTv) topBar.addView(barButton("Chat only", R.drawable.ic_phone, iconOnly) { enterCompanion(auto = false) })
        topBar.addView(barButton("Settings", R.drawable.ic_settings, iconOnly) { showSettings() })
        // One button for both, so the bar still fits on a phone: leave alone, or end it for everyone.
        topBar.addView(barButton("Leave", R.drawable.ic_leave, iconOnly) { confirmLeave() })
        root.addView(topBar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP))

        chatOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.BOTTOM or Gravity.START
        }
        root.addView(
            chatOverlay,
            FrameLayout.LayoutParams(dp(340), WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
                setMargins(dp(16), dp(16), dp(16), dp(96))
            },
        )

        // Who is in voice and who is talking; stays visible when the controls hide.
        voiceStrip = text(14f, Color.WHITE).apply {
            background = pill(Color.argb(200, 0x1A, 0x09, 0x33))
            setPadding(dp(14), dp(6), dp(14), dp(7))
            visibility = View.GONE
        }
        root.addView(
            voiceStrip,
            FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                setMargins(dp(24), dp(84), dp(16), 0)
            },
        )

        chatPanel = buildChatPanel()
        root.addView(chatPanel, FrameLayout.LayoutParams(dp(CHAT_PANEL_DP), MATCH_PARENT, Gravity.END))

        companionView = buildCompanionView()
        root.addView(companionView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        statusText = text(14f, ON_SURFACE).apply {
            background = pill(Color.argb(220, 0x1A, 0x09, 0x33))
            setPadding(dp(20), dp(10), dp(20), dp(10))
            visibility = View.GONE
        }
        root.addView(statusText, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.CENTER))

        setContentView(root)
    }

    private fun showStatus(text: String) {
        statusText.text = text
        statusText.visibility = View.VISIBLE
    }

    private fun showMembers(members: List<Member>) {
        this.members = members
        membersText.text = bingeLabel() + members.map { it.name }.distinct().joinToString(", ")
        renderVoice()
        val self = me ?: return
        val ownTv = members.any { it.id != self.id && it.device == "tv" && it.name.equals(self.name, ignoreCase = true) }
        if (!isTv && !companion && !autoSwitched && ownTv) {
            autoSwitched = true
            enterCompanion(auto = true)
        }
    }

    // --- voice ---

    private fun toggleVoice() {
        if (voice != null) {
            stopVoice()
            return
        }
        when {
            !packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE) -> startVoice(withMic = false)
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED -> startVoice(withMic = true)
            else -> micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun startVoice(withMic: Boolean) {
        val self = me ?: return
        if (voice != null) return
        val chat = try {
            VoiceChat(this, iceServers) { connection.send(it) }
        } catch (e: Throwable) {
            Toast.makeText(this, "Voice chat isn't available on this device.", Toast.LENGTH_LONG).show()
            return
        }
        chat.onSpeaking = { ids ->
            speaking = ids
            // Lower the movie while someone else talks.
            player.volume = if (ids.any { it != me?.id }) DUCK_VOLUME else 1f
            renderVoice()
        }
        chat.onPeerHealth = { id, ok ->
            if (ok) brokenVoice.remove(id) else brokenVoice.add(id)
            renderVoice()
        }
        voice = chat
        muted = false
        chat.start(self.id, withMic)
        if (!withMic) {
            Toast.makeText(this, "No mic available, so you're listening only.", Toast.LENGTH_LONG).show()
        }
        for (b in listOf(voiceButton, companionVoiceButton)) label(b, "Leave voice", R.drawable.ic_mic_off)
        for (b in listOf(muteButton, companionMuteButton)) {
            label(b, "Mute", R.drawable.ic_mic_off)
            b.visibility = if (chat.hasMic) View.VISIBLE else View.GONE
        }
    }

    private fun stopVoice() {
        val chat = voice ?: return
        voice = null
        chat.stop()
        speaking = emptySet()
        brokenVoice.clear()
        if (::player.isInitialized) player.volume = 1f
        for (b in listOf(voiceButton, companionVoiceButton)) label(b, "Join voice", R.drawable.ic_mic)
        for (b in listOf(muteButton, companionMuteButton)) b.visibility = View.GONE
        renderVoice()
    }

    private fun toggleMute() {
        muted = !muted
        voice?.setMuted(muted)
        for (b in listOf(muteButton, companionMuteButton)) {
            if (muted) label(b, "Unmute", R.drawable.ic_mic) else label(b, "Mute", R.drawable.ic_mic_off)
        }
    }

    private fun renderVoice() {
        val inVoice = members.filter { it.voice }
        voiceStrip.visibility = if (inVoice.isEmpty() || companion) View.GONE else View.VISIBLE
        companionVoice.visibility = if (inVoice.isEmpty()) View.GONE else View.VISIBLE
        val line = SpannableStringBuilder().apply {
            append("Voice  ")
            setSpan(ForegroundColorSpan(ON_SURFACE_VARIANT), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            inVoice.forEachIndexed { i, m ->
                if (i > 0) append("   ")
                val start = length
                if (m.id in speaking) append("● ")
                append(m.name)
                if (m.id == me?.id) append(" (you)")
                if (m.muted) append(" · muted")
                if (m.id in brokenVoice) append(" · can't connect")
                val color = when {
                    m.id in brokenVoice -> Color.rgb(0xFF, 0x52, 0x52)
                    m.id in speaking -> ACCENT
                    else -> Color.WHITE
                }
                setSpan(ForegroundColorSpan(color), start, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                if (m.id in speaking) setSpan(StyleSpan(Typeface.BOLD), start, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        voiceStrip.text = line
        companionVoice.text = line
    }

    private fun renderChat() {
        renderChatOverlay()
        renderHistory(chatPanelHistory, BUBBLE_SEE_THROUGH)
        renderHistory(companionHistory, BUBBLE_SOLID)
    }

    /**
     * Chat history as message bubbles: yours on the right in amber, everyone else's on the left under
     * their name, and joins, pauses and the like as small centered notes.
     */
    private fun renderHistory(list: LinearLayout, otherColor: Int) {
        list.removeAllViews()
        var previous: ChatMessage? = null
        for (m in chat.takeLast(100)) {
            val run = previous != null && !previous.system && !m.system && previous.from == m.from
            list.addView(messageView(m, run, otherColor), LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
                topMargin = dp(if (run) 2 else 10)
            })
            previous = m
        }
        (list.parent as? ScrollView)?.let { scroll -> scroll.post { scroll.fullScroll(View.FOCUS_DOWN) } }
    }

    private fun messageView(m: ChatMessage, run: Boolean, otherColor: Int): View {
        if (m.system) {
            return text(12f, ON_SURFACE_VARIANT).apply {
                text = m.text
                gravity = Gravity.CENTER
                setShadowLayer(3f, 0f, 1f, Color.BLACK)
            }
        }
        val mine = m.from == me?.name
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = if (mine) Gravity.END else Gravity.START
        }
        if (!mine && !run) {
            column.addView(text(12f, nameColor(m.from)).apply {
                text = m.from
                setTypeface(typeface, Typeface.BOLD)
                setPadding(dp(12), 0, dp(12), dp(2))
                setShadowLayer(3f, 0f, 1f, Color.BLACK)
            }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        }
        // WRAP_CONTENT: a vertical LinearLayout otherwise stretches each bubble to the full width.
        column.addView(text(15f, if (mine) Color.BLACK else Color.WHITE).apply {
            text = m.text
            maxWidth = (resources.displayMetrics.widthPixels * 0.75f).toInt().coerceAtMost(dp(280))
            background = GradientDrawable().apply {
                setColor(if (mine) ACCENT else otherColor)
                cornerRadius = dp(18).toFloat()
            }
            setPadding(dp(12), dp(7), dp(12), dp(8))
            setLineSpacing(0f, 1.1f)
        }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        return column
    }

    /** Each person keeps one name color, picked from their name. */
    private fun nameColor(name: String): Int = NAME_COLORS[Math.floorMod(name.hashCode(), NAME_COLORS.size)]

    /**
     * This device's room settings. Each device keeps its own, so chat can pop up on the TV and not on
     * the phone, or the other way round. The video player's own gear menu (audio, subtitles) can't
     * take extra items, so this is a separate button.
     */
    private fun showSettings() {
        val popups = switch(prefs.chatPopups)
        val row = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(24), dp(8), dp(24), dp(8))
            addView(LinearLayout(this@RoomActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(text(16f, ON_SURFACE).apply { text = "Chat pop-ups" })
                addView(text(14f, ON_SURFACE_VARIANT).apply { text = "Show new messages over the video on this device." })
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(popups, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { marginStart = dp(16) })
            isFocusable = false
            setOnClickListener { popups.toggle() }
        }
        present(
            dialog()
                .setTitle("Settings")
                .setView(row)
                .setPositiveButton("Done") { _, _ ->
                    if (prefs.chatPopups != popups.isChecked) {
                        prefs.chatPopups = popups.isChecked
                        renderChatOverlay()
                    }
                }
                .setNegativeButton("Cancel", null),
        )
        popups.requestFocus()
    }

    /** Shows the last few messages for 10 seconds each, like a game chat. */
    private fun renderChatOverlay() {
        val now = System.currentTimeMillis()
        val serverNow = sync.clock.serverNow(now)
        val recent = if (chatPanel.visibility == View.VISIBLE || !prefs.chatPopups) emptyList()
        else chat.takeLast(6).filter { serverNow - it.ts < CHAT_FADE_MS }
        chatOverlay.removeAllViews()
        for (m in recent) {
            val age = serverNow - m.ts
            val view = text(14f, if (m.system) Color.LTGRAY else Color.WHITE).apply {
                text = formatMessage(m)
                background = GradientDrawable().apply { setColor(Color.argb(200, 0x1A, 0x09, 0x33)); cornerRadius = dp(16).toFloat() }
                setPadding(dp(12), dp(6), dp(12), dp(7))
                alpha = ((CHAT_FADE_MS - age) / 2000f).coerceIn(0f, 1f)
            }
            chatOverlay.addView(
                view,
                LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(4) },
            )
        }
    }

    private fun formatMessage(m: ChatMessage): CharSequence {
        if (m.system) {
            return SpannableStringBuilder(m.text).apply {
                setSpan(StyleSpan(Typeface.ITALIC), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        val color = if (m.from == me?.name) ACCENT else nameColor(m.from)
        return SpannableStringBuilder().apply {
            append(m.from)
            setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            setSpan(ForegroundColorSpan(color), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            append("  ")
            append(m.text)
        }
    }

    /**
     * Chat opens as a see-through panel along the right edge, so the movie stays full size and visible
     * behind it. Back or the remote's Menu button closes it.
     */
    private fun openChat() {
        if (chatPanel.visibility == View.VISIBLE) return
        chatPanel.visibility = View.VISIBLE
        closeChatOnBack.isEnabled = true
        (topBar.layoutParams as FrameLayout.LayoutParams).marginEnd = dp(CHAT_PANEL_DP)
        topBar.requestLayout()
        renderChat()
        // With a remote, the D-pad could wander back into the player and top bar, which grab it and hide the panel's
        // controls. While chat is open only the panel takes focus; Back or Menu closes it.
        setBehindChatFocusable(false)
        chatPanelInput.post { chatPanelInput.requestFocus() }
    }

    private fun setBehindChatFocusable(focusable: Boolean) {
        val block = if (focusable) ViewGroup.FOCUS_AFTER_DESCENDANTS else ViewGroup.FOCUS_BLOCK_DESCENDANTS
        playerView.descendantFocusability = block
        playerView.isFocusable = focusable
        topBar.descendantFocusability = block
    }

    private fun closeChat() {
        if (chatPanel.visibility != View.VISIBLE) return
        chatPanel.visibility = View.GONE
        closeChatOnBack.isEnabled = false
        setBehindChatFocusable(true)
        (topBar.layoutParams as FrameLayout.LayoutParams).marginEnd = 0
        topBar.requestLayout()
        hideKeyboard(chatPanelInput)
        playerView.requestFocus()
    }

    private fun buildChatPanel(): LinearLayout {
        // A soft shadow keeps text readable over bright scenes now that the panel is see-through.
        chatPanelHistory = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, dp(8)) }
        chatPanelInput = chatInput()
        val send = { sendChat(chatPanelInput) }
        chatPanelInput.setOnEditorActionListener { _, actionId, _ -> sendOnAction(actionId, send) }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            // A see-through side sheet: rounded on the movie's side, so the film stays visible behind it.
            background = GradientDrawable().apply {
                setColor(Color.argb(180, 0x1A, 0x09, 0x33))
                val r = dp(28).toFloat()
                cornerRadii = floatArrayOf(r, r, 0f, 0f, 0f, 0f, r, r)
            }
            visibility = View.GONE
            val header = LinearLayout(this@RoomActivity).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(text(22f, ON_SURFACE).apply { text = "Chat"; typeface = MEDIUM }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                addView(barButton("Close", R.drawable.ic_close, iconOnly = true) { closeChat() })
            }
            addView(header, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(4) })
            addView(ScrollView(this@RoomActivity).apply { isVerticalScrollBarEnabled = false; addView(chatPanelHistory) }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(composer(chatPanelInput, send))
        }.also { panel -> padForSystemBars(panel, dp(20), dp(16), dp(16), dp(16)) }
    }

    /** The message box: a rounded field with a round amber Send button beside it. */
    private fun composer(input: EditText, send: () -> Unit) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        if (input.id == View.NO_ID) input.id = View.generateViewId()
        addView(input, LinearLayout.LayoutParams(0, dp(48), 1f))
        addView(ImageButton(this@RoomActivity).apply {
            // Left from Send goes to the message box, and Right from the box to Send, whatever else is nearby.
            id = View.generateViewId()
            nextFocusLeftId = input.id
            input.nextFocusRightId = id
            setImageResource(R.drawable.ic_send)
            imageTintList = ColorStateList.valueOf(ON_ACCENT)
            contentDescription = "Send"
            tooltipText = "Send"
            setOnClickListener { send() }
            val focused = intArrayOf(android.R.attr.state_focused)
            background = StateListDrawable().apply {
                addState(focused, pill(ACCENT).apply { setStroke(dp(2), Color.WHITE) })
                addState(intArrayOf(), pill(ACCENT))
            }
            stateListAnimator = null
        }, LinearLayout.LayoutParams(dp(48), dp(48)).apply { marginStart = dp(8) })
    }

    /**
     * Keeps a view clear of the status bar, navigation bar, camera cutout and keyboard. Android 15 always
     * draws apps edge to edge, so the views have to make room themselves.
     */
    private fun padForSystemBars(view: View, left: Int, top: Int, right: Int, bottom: Int) {
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            v.setPadding(left + bars.left, top + bars.top, right + bars.right, bottom + bars.bottom)
            insets
        }
    }

    // --- phone as a chat screen ---

    private fun buildCompanionView(): LinearLayout {
        companionTitle = text(22f, ON_SURFACE).apply { typeface = MEDIUM; maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        companionVoice = text(14f, ON_SURFACE).apply { visibility = View.GONE }
        companionHistory = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, dp(8)) }
        companionVoiceButton = barButton("Join voice", R.drawable.ic_mic) { toggleVoice() }
        companionMuteButton = barButton("Mute", R.drawable.ic_mic_off) { toggleMute() }.apply { visibility = View.GONE }
        val input = chatInput()
        val send = { sendChat(input) }
        input.setOnEditorActionListener { _, actionId, _ -> sendOnAction(actionId, send) }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(SURFACE)
            visibility = View.GONE
            addView(LinearLayout(this@RoomActivity).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(LinearLayout(this@RoomActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(companionTitle)
                    addView(text(14f, ON_SURFACE_VARIANT).apply { text = "Chat only. The video plays on your TV."; maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
                }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                addView(barButton("Watch here", R.drawable.ic_phone) { exitCompanion() })
            })
            addView(LinearLayout(this@RoomActivity).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(companionVoice, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                addView(companionVoiceButton)
                addView(companionMuteButton)
            }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(12) })
            addView(ScrollView(this@RoomActivity).apply { isVerticalScrollBarEnabled = false; addView(companionHistory) }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f).apply { topMargin = dp(8) })
            addView(composer(input, send), LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(4) })
        }.also { view -> padForSystemBars(view, dp(16), dp(12), dp(16), dp(12)) }
    }

    private fun enterCompanion(auto: Boolean) {
        if (companion) return
        companion = true
        closeChat()
        sync.stop()
        player.stop()
        player.clearMediaItems()
        loadedMediaId = null
        for (v in listOf(playerView, topBar, chatOverlay, voiceStrip)) v.visibility = View.GONE
        companionView.visibility = View.VISIBLE
        // A chat screen wants the keyboard and the status bar back, and works best upright.
        WindowInsetsControllerCompat(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
        ViewCompat.requestApplyInsets(companionView)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        renderChat()
        renderVoice()
        if (auto) {
            Toast.makeText(this, "You're on the TV too, so this phone is now just chat. Tap Watch here to switch back.", Toast.LENGTH_LONG).show()
        }
    }

    private fun exitCompanion() {
        if (!companion) return
        companion = false
        hideKeyboard(companionView)
        companionView.visibility = View.GONE
        playerView.visibility = View.VISIBLE
        chatOverlay.visibility = View.VISIBLE
        renderVoice()
        WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        sync.start()
        lastState?.let { applyState(it, lastMedia) }
        playerView.requestFocus()
    }

    // --- chat input helpers ---

    private fun chatInput() = EditText(this).apply {
        hint = "Message"
        setSingleLine()
        gravity = Gravity.CENTER_VERTICAL
        // In landscape Android otherwise swaps the whole screen for a plain white text box with its own SEND button.
        // Keep the keyboard below the chat panel, so the video and messages stay in view while typing.
        imeOptions = EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
        setTextColor(Color.WHITE)
        setHintTextColor(Color.GRAY)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        val focused = intArrayOf(android.R.attr.state_focused)
        background = StateListDrawable().apply {
            addState(focused, GradientDrawable().apply { setColor(BUBBLE_SOLID); cornerRadius = dp(22).toFloat(); setStroke(dp(2), ACCENT) })
            addState(intArrayOf(), GradientDrawable().apply { setColor(BUBBLE_SOLID); cornerRadius = dp(22).toFloat() })
        }
        setPadding(dp(16), dp(10), dp(16), dp(10))
    }

    private fun sendChat(input: EditText) {
        val t = input.text.toString().trim()
        if (t.isNotEmpty()) connection.send(Protocol.chat(t))
        input.setText("")
    }

    private fun sendOnAction(actionId: Int, send: () -> Unit): Boolean {
        if (actionId != EditorInfo.IME_ACTION_SEND && actionId != EditorInfo.IME_ACTION_DONE) return false
        send()
        return true
    }

    private fun hideKeyboard(view: View) {
        getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(view.windowToken, 0)
    }

    private fun confirmLeave() {
        if (!host) {
            present(
                dialog()
                    .setTitle("Leave the watch party?")
                    .setPositiveButton("Leave") { _, _ -> finish() }
                    .setNegativeButton("Stay", null),
            )
            return
        }
        present(
            dialog()
                .setTitle("Leave the watch party?")
                .setMessage("Leave just takes you out. End party sends everyone back to the home screen.")
                .setPositiveButton("Leave") { _, _ -> finish() }
                .setNeutralButton("End party") { _, _ -> connection.send(Protocol.end()) }
                .setNegativeButton("Cancel", null),
        )
    }

    // --- binge ---

    /** The video [delta] places from the current one in the binge, if there is one. Host only. */
    private fun bingeStep(delta: Int): MediaItem? {
        val items = queue?.items ?: return null
        if (!host) return null
        val at = items.indexOfFirst { it.id == lastMedia?.id }
        return if (at < 0) null else items.getOrNull(at + delta)
    }

    private fun playForEveryone(item: MediaItem) = connection.send(Protocol.select(item.id))

    private fun bingeLabel(): String {
        val items = queue?.items ?: return ""
        val at = items.indexOfFirst { it.id == lastMedia?.id }
        return if (at < 0) "" else "${if (lastMedia?.part != null) "Part" else "Binge"} ${at + 1} of ${items.size} · "
    }

    private fun setQueue(q: Queue?) {
        queue = q
        updateBingeButtons()
        showMembers(members)
        val advance = q?.advance
        val next = advance?.let { a -> q.items.firstOrNull { it.id == a.mediaId } }
        if (next == null) {
            upNext?.dismiss()
            upNext = null
            return
        }
        if (upNext?.isShowing == true) return
        if (!host) {
            Toast.makeText(this, "Up next: ${next.title}", Toast.LENGTH_LONG).show()
            return
        }
        // The host can start it right away or stay on this video; otherwise it starts by itself.
        upNext = present(
            dialog()
                .setTitle("Up next")
                .setMessage(next.title)
                .setPositiveButton("Play now") { _, _ -> playForEveryone(next) }
                .setNegativeButton("Stay here") { _, _ -> connection.send(Protocol.cancelAdvance()) },
        ).also { d ->
            val tick = object : Runnable {
                override fun run() {
                    if (!d.isShowing) return
                    val left = ((advance.at - sync.clock.serverNow(System.currentTimeMillis())) / 1000).coerceAtLeast(0)
                    d.setMessage("${next.title}\n\nStarts in $left s")
                    main.postDelayed(this, 500)
                }
            }
            main.post(tick)
        }
    }

    private fun updateBingeButtons() {
        if (!::prevButton.isInitialized) return
        val inBinge = host && queue != null && !companion
        prevButton.visibility = if (inBinge) View.VISIBLE else View.GONE
        nextButton.visibility = if (inBinge) View.VISIBLE else View.GONE
        prevButton.isEnabled = bingeStep(-1) != null
        nextButton.isEnabled = bingeStep(1) != null
        prevButton.alpha = if (prevButton.isEnabled) 1f else 0.4f
        nextButton.alpha = if (nextButton.isEnabled) 1f else 0.4f
    }

    private fun pickVideo() {
        lifecycleScope.launch {
            val items = try {
                api.library()
            } catch (e: Exception) {
                Toast.makeText(this@RoomActivity, e.message ?: "Couldn't load the library.", Toast.LENGTH_SHORT).show()
                return@launch
            }
            if (items.isEmpty()) {
                Toast.makeText(this@RoomActivity, "The library is empty.", Toast.LENGTH_SHORT).show()
                return@launch
            }
            val labels = items.map { if (it.folder.isEmpty()) it.title else "${it.folder} / ${it.title}" }.toTypedArray()
            present(
                dialog()
                    .setTitle("Play for everyone")
                    .setItems(labels) { _, which -> connection.send(Protocol.select(items[which].id)) }
                    .setNegativeButton("Cancel", null),
            )
        }
    }

    // --- view helpers ---

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun text(sizeSp: Float, color: Int) = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        setTextColor(color)
    }

    /** A fully rounded shape, as Material 3 uses for buttons and chips. */
    /**
     * Media3's own focus mark on the play/pause, skip and seek-bar controls is a faint grey that's easy to lose from
     * the couch. Give them the same orange the top bar uses: an orange circle behind the focused button, and an
     * orange outline around the seek bar while it has focus.
     */
    private fun highlightControlFocus() {
        val focused = intArrayOf(android.R.attr.state_focused)
        val ids = listOf(
            androidx.media3.ui.R.id.exo_play_pause, androidx.media3.ui.R.id.exo_rew, androidx.media3.ui.R.id.exo_ffwd,
            androidx.media3.ui.R.id.exo_prev, androidx.media3.ui.R.id.exo_next, androidx.media3.ui.R.id.exo_settings,
            androidx.media3.ui.R.id.exo_subtitle, androidx.media3.ui.R.id.exo_overflow_show, androidx.media3.ui.R.id.exo_overflow_hide,
        )
        for (id in ids) {
            val button = playerView.findViewById<View>(id) ?: continue
            button.background = StateListDrawable().apply {
                addState(focused, GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(ACCENT) })
                addState(intArrayOf(), GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.TRANSPARENT) })
            }
            if (button is ImageButton) button.imageTintList = ColorStateList(arrayOf(focused, intArrayOf()), intArrayOf(ON_ACCENT, Color.WHITE))
        }
        playerView.findViewById<DefaultTimeBar>(androidx.media3.ui.R.id.exo_progress)?.apply {
            setPlayedColor(ACCENT)
            setScrubberColor(ACCENT)
            background = StateListDrawable().apply {
                addState(focused, GradientDrawable().apply { setColor(Color.argb(90, 0xFF, 0x8E, 0x44)); setStroke(dp(2), ACCENT); cornerRadius = dp(12).toFloat() })
                addState(intArrayOf(), GradientDrawable().apply { setColor(Color.TRANSPARENT) })
            }
        }
    }

    private fun pill(color: Int) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(100).toFloat()
    }

    /**
     * A Material 3 tonal button with an icon: icon and label, or a round icon-only button (its name shows
     * on long-press). Selected with the remote it turns amber.
     */
    private fun barButton(label: String, icon: Int, iconOnly: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        tag = iconOnly
        isAllCaps = false
        typeface = MEDIUM
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setOnClickListener { onClick() }
        val focused = intArrayOf(android.R.attr.state_focused)
        val pressed = intArrayOf(android.R.attr.state_pressed)
        // Amber marks the focused button; no ring needed on top.
        background = StateListDrawable().apply {
            addState(focused, pill(ACCENT))
            addState(pressed, pill(ACCENT))
            addState(intArrayOf(), pill(TONAL))
        }
        val content = ColorStateList(arrayOf(focused, pressed, intArrayOf()), intArrayOf(ON_ACCENT, ON_ACCENT, ON_SURFACE))
        setTextColor(content)
        compoundDrawableTintList = content
        compoundDrawablePadding = dp(8)
        stateListAnimator = null
        minHeight = 0
        minimumHeight = 0
        minWidth = 0
        minimumWidth = 0
        gravity = Gravity.CENTER
        label(this, label, icon)
        layoutParams = LinearLayout.LayoutParams(if (iconOnly) dp(48) else WRAP_CONTENT, dp(if (iconOnly) 48 else 40)).apply { marginStart = dp(8) }
    }

    /** Sets a bar button's name and icon (voice and mute change theirs). */
    private fun label(button: Button, label: String, icon: Int) {
        val iconOnly = button.tag == true
        button.contentDescription = label
        button.tooltipText = label
        val drawable = getDrawable(icon)!!.mutate().apply { setBounds(0, 0, dp(20), dp(20)) }
        button.setCompoundDrawablesRelative(drawable, null, null, null)
        if (iconOnly) {
            button.text = ""
            button.compoundDrawablePadding = 0
            button.setPadding(dp(14), 0, dp(14), 0)
        } else {
            button.text = label
            button.setPadding(dp(16), 0, dp(24), 0)
        }
    }

    /**
     * A Material 3 switch: a 52x32dp pill track with a round thumb that grows when on. Drawn here
     * because the platform Switch takes the device's own look, which on Android TV resembles a radio button.
     */
    private fun switch(on: Boolean) = Switch(this).apply {
        isChecked = on
        showText = false
        thumbTintList = null
        trackTintList = null
        val checked = intArrayOf(android.R.attr.state_checked)
        val focused = intArrayOf(android.R.attr.state_focused)
        fun track(fill: Int, outline: Int) = GradientDrawable().apply {
            setColor(fill)
            setStroke(dp(2), outline)
            cornerRadius = dp(16).toFloat()
            setSize(dp(52), dp(32))
        }
        // The thumb sits in a 26x32dp box (half the track's width, its full height) so it's centered
        // vertically and the switch stays 52dp wide: 24dp when on, 16dp when off. A LayerDrawable, not an
        // InsetDrawable: Switch treats an InsetDrawable's insets as padding and optical insets, which change
        // with the thumb's size, so the on thumb was pushed past the end of the track and cut off.
        fun thumb(color: Int, size: Int): LayerDrawable {
            val x = dp((26 - size) / 2)
            val y = dp((32 - size) / 2)
            return LayerDrawable(arrayOf(GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(color)
                setSize(dp(size), dp(size))
            })).apply { setLayerInset(0, x, y, x, y) }
        }
        trackDrawable = StateListDrawable().apply {
            addState(checked, track(ACCENT, ACCENT))
            addState(focused, track(SURFACE, ACCENT))
            addState(intArrayOf(), track(SURFACE, ON_SURFACE_VARIANT))
        }
        thumbDrawable = StateListDrawable().apply {
            // White on amber reads as clearly on; a dark thumb looked switched off.
            addState(checked, thumb(Color.WHITE, 24))
            addState(intArrayOf(), thumb(ON_SURFACE_VARIANT, 16))
        }
        switchMinWidth = dp(52)
    }

    private fun dialog() = AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)

    /** Shows a dialog in Material 3 dress: rounded 28dp surface and amber buttons. */
    private fun present(builder: AlertDialog.Builder): AlertDialog = builder.show().apply {
        window?.setBackgroundDrawable(GradientDrawable().apply {
            setColor(SURFACE_HIGH)
            cornerRadius = dp(28).toFloat()
        })
        for (which in listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL)) {
            getButton(which)?.apply {
                setTextColor(ACCENT)
                isAllCaps = false
                typeface = MEDIUM
            }
        }
    }

    companion object {
        const val EXTRA_ROOM = "room"
        const val EXTRA_HOST = "host"
        private const val CHAT_FADE_MS = 10_000L
        /** How far the remote's fast-forward and rewind buttons jump. */
        private const val SKIP_MS = 10_000L
        private const val DUCK_VOLUME = 0.3f
        private const val CHAT_PANEL_DP = 320
        /** The app's orange, as on the home screen. */
        private val ACCENT = Color.rgb(0xFF, 0x8E, 0x44)
        // Material 3 dark roles, built around the orange on deep purple.
        private val ON_ACCENT = Color.rgb(0x1A, 0x09, 0x33)
        private val SURFACE = Color.rgb(0x1A, 0x09, 0x33)
        private val SURFACE_HIGH = Color.rgb(0x3D, 0x1D, 0x6E)
        private val TONAL = Color.argb(200, 0x2A, 0x12, 0x50)
        private val ON_SURFACE = Color.rgb(0xEC, 0xEE, 0xF3)
        private val ON_SURFACE_VARIANT = Color.rgb(0xC4, 0xB3, 0xE0)
        private val MEDIUM: Typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        /** Other people's bubbles: solid on the phone's chat screen, see-through over the movie. */
        private val BUBBLE_SOLID = Color.rgb(0x3D, 0x1D, 0x6E)
        private val BUBBLE_SEE_THROUGH = Color.argb(200, 0x2A, 0x12, 0x50)
        private val NAME_COLORS = intArrayOf(
            Color.rgb(0x7C, 0xC4, 0xFF), Color.rgb(0x8E, 0xE0, 0x9B), Color.rgb(0xF4, 0x8F, 0xB1),
            Color.rgb(0xB3, 0x9D, 0xFF), Color.rgb(0x6F, 0xE0, 0xD6), Color.rgb(0xFF, 0xB0, 0x7A),
        )

        fun start(context: Context, roomId: String, host: Boolean = true) {
            context.startActivity(Intent(context, RoomActivity::class.java).putExtra(EXTRA_ROOM, roomId).putExtra(EXTRA_HOST, host))
        }
    }
}
