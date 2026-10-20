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
import android.graphics.LinearGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.content.res.ColorStateList
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.ShapeDrawable
import android.graphics.drawable.shapes.RectShape
import android.graphics.drawable.StateListDrawable
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.PopupWindow
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
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
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.dp
import androidx.core.content.res.ResourcesCompat
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
import androidx.media3.ui.PlayerView
import androidx.media3.ui.TimeBar
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
    /** "Paused at 13:33" / "Playing" for a moment once the server confirms a press, so one that didn't land shows. */
    private lateinit var playedText: TextView
    private val hidePlayed = Runnable { playedText.visibility = View.GONE }
    private lateinit var noticeText: TextView
    private val hideNotice = Runnable { noticeText.visibility = View.GONE }
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
    private lateinit var companionWho: TextView
    private lateinit var companionProgress: View
    private lateinit var companionTime: TextView
    private lateinit var companionLength: TextView
    /** The player's round thumbnail by the title, and its "Up next" line by the seek bar. */
    private var posterView: ImageView? = null
    private var upNextText: TextView? = null
    private var posterFor: String? = null
    /** The phone's double-tap jumps: what they show, which side the last one was on, how far, and until when another tap adds to it. */
    private lateinit var skipRipple: SkipRipple
    private var skipSide = 0
    private var skipSeconds = 0
    private var skipUntil = 0L
    private var skipTo = 0L

    private val main = Handler(Looper.getMainLooper())
    /** The player control a TV remote was last on, so it's there again when the controls come back. */
    private var lastControlFocus: Int? = null
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
    /** Playing the server's lighter copy for slow connections (Settings > Video quality). */
    private var light = false
    /** Auto quality found this device kept waiting for video: the rest of the party plays the lighter copy. */
    private var slowConnection = false
    private val slowWatch = SlowConnection()
    /** When the player started waiting for video while the party plays (or waits for screens); null when it isn't. */
    private var waitingSince: Long? = null
    private var waitingAfterJump = false
    private var lastJumpAt = 0L
    /** The player hasn't shown the video it just loaded yet: that first wait doesn't count. */
    private var firstLoad = true
    private val longWait = Runnable { if (waitingSince != null) slowDown() }

    /** Phone showing only chat, because its owner is watching on a TV. */
    private var companion = false
    private var autoSwitched = false
    private var ended = false
    /** False for viewers who joined with the party code: no Change video, no End party. */
    private var host = true
    private var roomCode = ""
    /** The host watching alone (Watch alone): no chat or voice until they invite friends. */
    private var solo = false
    private val chatButtons = mutableListOf<View>()
    /** The TV's Invite friends, only while watching alone: friends get the code from a phone or the web. */
    private var tvInvite: View? = null

    /** Back outside the chat asks first, so one press too many doesn't drop you out of the party. */
    private val confirmLeaveOnBack = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() = confirmLeave(back = true)
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
    /** The binge's next video and when it starts, while the Up next card counts down. Compose state, read by [nextCardView]. */
    private val nextUp = mutableStateOf<Pair<MediaItem, Long>?>(null)
    /** Bumped to put the remote back on the Up next card's Play now (Up from the seek bar, or after the controls hide). */
    private val nextFocus = mutableStateOf(0)
    private lateinit var nextCardView: ComposeView
    /** Skip intro / Skip recap while one is on: which, and where it ends (seconds). Compose state, read by [skipView]. */
    private val skipPart = mutableStateOf<Pair<String, Double>?>(null)
    /** Bumped to put the remote on Skip intro (Up from the seek bar, or after the controls hide). */
    private val skipFocus = mutableStateOf(0)
    private lateinit var skipView: ComposeView
    /** Where the video was at the last check, and which video, so reaching the credits is noticed once as it happens. */
    private var lastTick = -1.0
    private var lastTickMedia: String? = null
    /** Up next (the list, not the countdown): open or not, and what it shows. Compose state, read by [upNextView]. */
    private val upNextOpen = mutableStateOf(false)
    private val upNextQueue = mutableStateOf<Queue?>(null)
    private val upNextMedia = mutableStateOf<MediaItem?>(null)
    private val listButtons = mutableListOf<View>()
    private lateinit var upNextView: ComposeView
    /** This host's party, for the library's Add videos (see [PartyLink]). */
    private var link: PartyLink.Party? = null
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
            renderCompanionStatus()
            main.postDelayed(this, 1000)
        }
    }

    private val marksTicker = object : Runnable {
        override fun run() {
            tickMarks()
            main.postDelayed(this, 250)
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
        // Subtitles start off, even when the file marks a track as the default; the subtitle button turns them on.
        // Forced ones (signs, lines in another language) still show when they match the sound's language.
        // English audio plays first in files with more than one language, as on the web (Settings can switch it).
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setIgnoredTextSelectionFlags(C.SELECTION_FLAG_DEFAULT)
            .setPreferredAudioLanguage("en")
            .build()
        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                if (!switchToConverted()) Toast.makeText(this@RoomActivity, "Can't play this video: ${error.errorCodeName}", Toast.LENGTH_LONG).show()
            }

            // In a binge, the server moves everyone on to the next video once a screen reports the end.
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) loadedMediaId?.let { connection.send(Protocol.ended(it)) }
                watchWaits(playbackState)
            }

            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                if (reason == Player.DISCONTINUITY_REASON_SEEK) lastJumpAt = SystemClock.elapsedRealtime()
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
        PlayerSync.startLag = prefs.startLag
        sync = PlayerSync(
            player,
            send = { type, position, at, skip -> connection.send(Protocol.position(type, position, at, skip)) },
            caughtUp = { position -> connection.send(Protocol.caughtUp(position)) },
        )
        buildLayout()
        playerView.player = player

        connection = RoomConnection(
            api.socketUrl(roomId, prefs.name, if (isTv) "tv" else "phone"),
            onMessage = ::onServerMessage,
            onStatus = ::onStatus,
        )
        connection.connect()
        if (host) link = PartyLink.Party(roomCode) { connection.send(it) }.also { PartyLink.party = it }
    }

    override fun onStart() {
        super.onStart()
        if (!companion) sync.start()
        main.post(chatTicker)
        main.post(marksTicker)
        if (!companion) playerView.requestFocus()
    }

    override fun onStop() {
        // Android doesn't let a backgrounded app keep the mic, so leave voice when the player goes away.
        stopVoice()
        // Watching alone, nobody else is watching: pause the party where it is, so it's there on return.
        if (solo && !ended && ::connection.isInitialized) {
            connection.send(Protocol.position("pause", player.currentPosition / 1000.0))
        }
        // Stop listening first so pausing here isn't broadcast as "paused" to everyone.
        sync.stop()
        player.playWhenReady = false
        main.removeCallbacks(chatTicker)
        main.removeCallbacks(marksTicker)
        super.onStop()
    }

    override fun onDestroy() {
        if (link != null && PartyLink.party === link) {
            PartyLink.party = null
            PartyLink.queue = null
            PartyLink.playing = null
            PartyLink.solo = false
        }
        prefs.startLag = PlayerSync.startLag
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
        // Left and right stay in the open Up next panel instead of wandering onto the hidden player controls.
        if (upNextOpen.value && isTv && event.keyCode in setOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT)) {
            super.dispatchKeyEvent(event)
            return true
        }
        // The remote stays on the Up next card's buttons instead of bringing up the controls; with the controls up,
        // Down goes back to them.
        if (isTv && nextCardView.hasFocus() && event.keyCode in DPAD_KEYS) {
            if (event.keyCode == KeyEvent.KEYCODE_DPAD_DOWN && playerView.isControllerFullyVisible) {
                if (event.action == KeyEvent.ACTION_DOWN) playerView.requestFocus()
                return true
            }
            return super.dispatchKeyEvent(event)
        }
        // On Skip intro, OK skips; any other direction brings up the controls, as it would without the button.
        if (isTv && skipView.hasFocus() && event.keyCode in DPAD_KEYS) {
            if (event.keyCode in OK_KEYS) return super.dispatchKeyEvent(event)
            if (event.action == KeyEvent.ACTION_DOWN) {
                playerView.requestFocus()
                playerView.showController()
            }
            return true
        }
        if (upToCorner(event)) return true
        if (showsControlsFirst(event)) {
            playerView.showController()
            return true
        }
        if (companion || !isMediaKey(event.keyCode)) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> sync.playPausePressed()
                KeyEvent.KEYCODE_MEDIA_PLAY -> player.playWhenReady = true
                KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_STOP -> sync.pausePressed()
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> sync.seekTo(player.currentPosition + SKIP_MS)
                KeyEvent.KEYCODE_MEDIA_REWIND -> sync.seekTo(player.currentPosition - SKIP_MS)
                KeyEvent.KEYCODE_MEDIA_NEXT -> bingeStep(1)?.let { playForEveryone(it) }
                KeyEvent.KEYCODE_MEDIA_PREVIOUS -> bingeStep(-1)?.let { playForEveryone(it) }
            }
        }
        return true
    }

    /**
     * Any arrow or OK press on the remote brings the controls up while they're hidden, as on YouTube for TV.
     * Left to the views, only right and down did: with nothing focused, Android looks for something to the right
     * of or below the top-left corner, and up or left find nothing. Where focus sits doesn't matter: when the
     * controls hide, Android hands focus to whatever it finds first, which can be outside the player.
     */
    private fun showsControlsFirst(event: KeyEvent): Boolean =
        !companion && event.action == KeyEvent.ACTION_DOWN && event.keyCode in DPAD_KEYS &&
            !playerView.isControllerFullyVisible && chatPanel.visibility != View.VISIBLE && !upNextOpen.value

    /**
     * Up from the top of the TV's controls (the seek bar) goes to Skip intro / Skip recap or the Up next card, whichever
     * shows. Left to Android it never did: Skip intro is only moved up above the seek bar (translationY), and focus
     * search goes by where a view is laid out, which is down among the buttons, below the bar; the Up next card sits
     * there too. So while the controls showed (paused, or just after a press) the remote couldn't reach either.
     */
    private fun upToCorner(event: KeyEvent): Boolean {
        if (!isTv || companion || !::skipView.isInitialized || !::nextCardView.isInitialized) return false
        val progress = playerView.findViewById<View>(androidx.media3.ui.R.id.exo_progress)
        val focused = currentFocus
        val onTopRow = focused != null && focused !== playerView && isInside(focused, playerView) &&
            (focused === progress || progress == null || !progress.isShown || !progress.isFocusable)
        val target = upFromControlsGoesTo(
            keyCode = event.keyCode,
            controlsShown = playerView.isControllerFullyVisible,
            onTopRow = onTopRow,
            panelOpen = chatPanel.visibility == View.VISIBLE || upNextOpen.value,
            skipShown = skipPart.value != null && skipView.visibility == View.VISIBLE,
            nextShown = nextUp.value != null && nextCardView.visibility == View.VISIBLE,
        ) ?: return false
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (target) {
                Corner.Skip -> focusCorner(skipView, skipFocus)
                Corner.NextCard -> focusCorner(nextCardView, nextFocus)
            }
        }
        return true
    }

    /**
     * How far Skip intro moves up while the TV's controls show: to just above the seek bar's line, measured from where
     * the bar is, not a fixed amount, so it doesn't float halfway up the screen. The bar's time bubble can't reach it:
     * that sits over the dot, which is near the start while an intro or recap plays.
     */
    private fun skipLift(): Float {
        val bar = playerView.findViewById<View>(androidx.media3.ui.R.id.exo_progress)
        val parent = skipView.parent as? View
        if (bar == null || parent == null || bar.height == 0 || skipView.height == 0) return dp(TV_CONTROLS_DP).toFloat()
        val barAt = IntArray(2).also { bar.getLocationInWindow(it) }[1]
        val parentAt = IntArray(2).also { parent.getLocationInWindow(it) }[1]
        // The pill's bottom edge (inside the view's shadow room) goes SKIP_GAP_DP above the bar's line, which TvTimeBar
        // draws 10dp up from its bottom.
        val pillBottom = skipView.bottom - dp(SHADOW_ROOM_DP)
        val line = barAt - parentAt + bar.height - dp(10)
        return (pillBottom - line + dp(SKIP_GAP_DP)).coerceAtLeast(0).toFloat()
    }

    private fun isMediaKey(keyCode: Int): Boolean = keyCode in setOf(
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK, KeyEvent.KEYCODE_MEDIA_PLAY,
        KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_STOP, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
        KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_PREVIOUS,
    )

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_BUTTON_Y, KeyEvent.KEYCODE_PROG_BLUE -> {
                if (!companion && !solo) {
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
                // Jumps wait for this screen to load the new spot, unless it's only for chat.
                connection.send(Protocol.player(!companion))
                iceServers = msg.iceServers
                voice?.rejoin(msg.you.id)
                chat.clear()
                chat.addAll(msg.chat)
                setSolo(msg.solo)
                showMembers(msg.members)
                applyState(msg.state, msg.media)
                setQueue(msg.queue)
                renderChat()
            }
            is ServerMessage.Solo -> setSolo(msg.solo)
            is ServerMessage.QueueChanged -> setQueue(msg.queue)
            is ServerMessage.State -> applyState(msg.state, msg.media, mine = msg.by != null && msg.by == me?.name)
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

    private fun applyState(state: PlaybackState, media: MediaItem?, mine: Boolean = false) {
        val before = lastState
        lastState = state
        // Paused or playing by someone's press. A jump's wait (hold) counts as playing, so it shows nothing.
        val paused = state.paused && !state.hold
        if (!companion && ::playedText.isInitialized && before != null && before.mediaId == state.mediaId && (before.paused && !before.hold) != paused) {
            playedText.text = if (paused) "Paused at ${clock(state.position)}" else "Playing"
            playedText.visibility = View.VISIBLE
            main.removeCallbacks(hidePlayed)
            main.postDelayed(hidePlayed, PLAYED_SHOWN_MS)
        }
        lastMedia = media
        upNextMedia.value = media
        if (link != null) PartyLink.playing = media?.id
        titleText.text = media?.let { playerTitle(it) } ?: nothingPlaying()
        companionTitle.text = media?.title ?: "Nothing playing"
        if (media?.id != posterFor) loadPoster(media)
        renderCompanionStatus()
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
                val direct = info == null || Playable.direct(info, media.size, isTv, metered(), DeviceDecoders(this@RoomActivity))
                load(media, converted = !direct, light = wantsLight(info))
            }
        }
        sync.setState(state, mine)
    }

    private fun metered() = getSystemService(ConnectivityManager::class.java)?.isActiveNetworkMetered == true

    /** Whether to play the lighter copy, by Settings > Video quality (and on Auto, whether this device kept waiting). */
    private fun wantsLight(info: MediaInfo?): Boolean = info?.convert == true &&
        (prefs.videoQuality == VideoQuality.LIGHT || (prefs.videoQuality == VideoQuality.AUTO && slowConnection))

    /**
     * Plays [media], either the original file or the server's converted copy ([light]: its lighter one), from
     * [startMs] when switching copies mid-video, so it doesn't load the start first.
     */
    private fun load(media: MediaItem, converted: Boolean, light: Boolean = false, startMs: Long? = null) {
        this.converted = converted || light
        this.light = light
        val converted = this.converted
        firstLoad = true
        waitingSince = null
        main.removeCallbacks(longWait)
        fun sub(index: Any, track: SubtitleTrack) =
            ExoMediaItem.SubtitleConfiguration.Builder(Uri.parse(api.subtitleUrl(media.id, index)))
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(track.lang)
                .setLabel(track.label)
                .build()
        // The converted copy drops the subtitles inside the file, so the server's copies of them come along.
        val inside = if (converted) mediaInfo?.subtitles.orEmpty().map { sub("e${it.index}", it) } else emptyList()
        val subs = media.subtitles.map { sub(it.index, it) } + inside
        val item = ExoMediaItem.Builder()
            .setUri(if (converted) api.hlsUrl(media.id, light) else api.streamUrl(media.id))
            .setMimeType(if (converted) MimeTypes.APPLICATION_M3U8 else null)
            .setMediaId(media.id)
            .setSubtitleConfigurations(subs)
            .build()
        if (startMs != null) player.setMediaItem(item, startMs) else player.setMediaItem(item)
        player.prepare()
    }

    /** Times each wait for video while the party plays (or waits for screens), so Auto quality can tell a slow connection. */
    private fun watchWaits(playbackState: Int) {
        val now = SystemClock.elapsedRealtime()
        if (playbackState == Player.STATE_READY) {
            val since = waitingSince
            waitingSince = null
            main.removeCallbacks(longWait)
            if (firstLoad) firstLoad = false
            else if (since != null && slowWatch.waited(now - since, waitingAfterJump, now)) slowDown()
            return
        }
        if (playbackState != Player.STATE_BUFFERING || firstLoad || waitingSince != null) return
        val state = lastState ?: return
        if (state.paused && !state.hold) return
        waitingSince = now
        waitingAfterJump = now - lastJumpAt < JUMP_WAIT_MS
        main.postDelayed(longWait, SlowConnection.LONG_MS)
    }

    /** Auto quality: this device keeps waiting for video, so it switches to the lighter copy for the rest of the party. */
    private fun slowDown() {
        waitingSince = null
        main.removeCallbacks(longWait)
        val media = lastMedia
        if (light || prefs.videoQuality != VideoQuality.AUTO || mediaInfo?.convert != true || media == null || media.id != loadedMediaId) return
        slowConnection = true
        connection.send(Protocol.quality(light = true, auto = true))
        load(media, converted = true, light = true, startMs = player.currentPosition)
        showNotice("Slow connection: switched to a lighter stream")
    }

    /** Settings > Video quality: keeps [choice] for this device and switches the playing video to match right away. */
    private fun setQuality(choice: String) {
        if (prefs.videoQuality == choice) return
        prefs.videoQuality = choice
        // Picking Original starts Auto afresh next time it's picked.
        if (choice == VideoQuality.ORIGINAL) slowConnection = false
        val media = lastMedia ?: return
        val info = mediaInfo ?: return
        if (media.id != loadedMediaId || wantsLight(info) == light) return
        val lighter = wantsLight(info)
        connection.send(Protocol.quality(light = lighter, auto = false))
        val direct = Playable.direct(info, media.size, isTv, metered(), DeviceDecoders(this))
        load(media, converted = !direct, light = lighter, startMs = player.currentPosition)
    }

    /** A short note in a pill at the bottom corner, like "Slow connection: switched to a lighter stream". */
    private fun showNotice(message: String) {
        noticeText.text = message
        noticeText.visibility = View.VISIBLE
        main.removeCallbacks(hideNotice)
        main.postDelayed(hideNotice, NOTICE_SHOWN_MS)
    }

    /** Settings > Video quality: Auto, Original or Lighter for this device. */
    private fun showQuality() {
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val picker = present(dialog().setTitle("Video quality").setView(content).setNegativeButton("Cancel", null))
        val device = if (isTv) "this device" else "this phone"
        val choices = listOf(
            Triple(VideoQuality.AUTO, "Auto", "The original file. Switches to a lighter stream if $device keeps waiting for video."),
            Triple(VideoQuality.ORIGINAL, "Original", "The full file whenever $device can play it${if (isTv) ", as today." else "."}"),
            Triple(VideoQuality.LIGHT, "Lighter (720p)", "A smaller stream for slow connections.${if (isTv) " The server converts it while you watch." else ""}"),
        )
        for ((value, label, detail) in choices) {
            val row = dialogRow(label, detail, radio(prefs.videoQuality == value)) {
                picker.dismiss()
                setQuality(value)
            }
            content.addView(row)
            if (prefs.videoQuality == value) row.requestFocus()
        }
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

        // The TV and the phone each get their own controls (tv_player_controls, phone_player_controls), which Media3
        // only takes from a layout file.
        val playerLayout = if (isTv) R.layout.tv_player_view else R.layout.phone_player_view
        playerView = (layoutInflater.inflate(playerLayout, root, false) as PlayerView).apply {
            useController = true
            controllerShowTimeoutMs = 4000
            setShowSubtitleButton(true)
            keepScreenOn = true
            setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { visibility ->
                topBar.visibility = visibility
                hideControlsOnBack.isEnabled = visibility == View.VISIBLE
                // Chat pop-ups move up out of the way of the TV's seek bar while the controls show.
                if (isTv) chatOverlay.animate().translationY(if (visibility == View.VISIBLE) -dp(80).toFloat() else 0f).setDuration(150).start()
                // Skip intro sits above the TV's seek bar while the controls show, and gets the remote back after.
                if (isTv && ::skipView.isInitialized) {
                    skipView.animate().translationY(if (visibility == View.VISIBLE) -skipLift() else 0f).setDuration(150).start()
                    if (visibility != View.VISIBLE && skipPart.value != null) skipFocus.value++
                }
                // Pausing brings the controls up and takes the remote off the Up next card; it goes back once they hide.
                if (isTv && visibility != View.VISIBLE && nextUp.value != null) nextFocus.value++
                // The phone's controls fade in rather than popping up.
                if (!isTv && visibility == View.VISIBLE) (findViewById<View>(R.id.phone_shade)?.parent as? View)?.apply {
                    alpha = 0f
                    animate().alpha(1f).setDuration(150).start()
                }
                // Media3 puts the remote back on play/pause each time the controls appear; go back to where it was.
                if (visibility == View.VISIBLE) lastControlFocus?.let { id -> post { findViewById<View>(id)?.takeIf { it.isShown }?.requestFocus() } }
            })
            // Media3 slides its own bars away in steps; these controls aren't laid out for that, so they just go.
            setControllerAnimationEnabled(false)
        }
        if (isTv) highlightControlFocus()
        skipButtons()
        root.addView(playerView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        if (!isTv) {
            skipRipple = SkipRipple(this)
            root.addView(skipRipple, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            doubleTapSkips()
        }

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
        if (isTv) {
            buildTvControls()
            root.addView(topBar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP))
        } else {
            buildPhoneControls()
        }

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
            background = pill(Color.argb(200, 0x18, 0x13, 0x1F))
            setPadding(dp(14), dp(6), dp(14), dp(7))
            visibility = View.GONE
        }
        root.addView(
            voiceStrip,
            FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                if (isTv) setMargins(dp(48), dp(100), dp(48), 0) else setMargins(dp(40), dp(72), dp(16), 0)
            },
        )

        chatPanel = buildChatPanel()
        // On the phone, touches on the open chat don't reach the video behind it (no double-tap jumps through it).
        if (!isTv) chatPanel.isClickable = true
        root.addView(chatPanel, FrameLayout.LayoutParams(dp(CHAT_PANEL_DP), MATCH_PARENT, Gravity.END))

        companionView = buildCompanionView()
        root.addView(companionView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        root.addView(buildUpNextView(), FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        // Both draw a shadow around themselves, inside SHADOW_ROOM_DP of padding (a view cuts off what's drawn past
        // its edges, which left a gray box around the white Skip intro); their margins give that room back.
        root.addView(buildSkipView(), FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            // Where the Up next card shows at the credits.
            setMargins(0, 0, dp((if (isTv) 48 else 24) - SHADOW_ROOM_DP), dp((if (isTv) 48 else 88) - SHADOW_ROOM_DP))
        })
        root.addView(buildNextCard(), FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            // Above a phone's seek bar; the TV hides its controls while the card is up.
            setMargins(0, 0, dp((if (isTv) 48 else 24) - SHADOW_ROOM_DP), dp((if (isTv) 48 else 88) - SHADOW_ROOM_DP))
        })

        statusText = text(14f, ON_SURFACE).apply {
            background = pill(Color.argb(220, 0x18, 0x13, 0x1F))
            setPadding(dp(20), dp(10), dp(20), dp(10))
            visibility = View.GONE
        }
        root.addView(statusText, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.CENTER))
        playedText = text(14f, ON_SURFACE).apply {
            background = pill(Color.argb(220, 0x18, 0x13, 0x1F))
            setPadding(dp(20), dp(10), dp(20), dp(10))
            visibility = View.GONE
        }
        // At the top, clear of the phone's big play button and the TV's seek bar.
        root.addView(playedText, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
            topMargin = dp(if (isTv) 48 else 24)
        })
        noticeText = text(14f, ON_SURFACE).apply {
            background = pill(Color.argb(235, 0x12, 0x0E, 0x18))
            setPadding(dp(16), dp(10), dp(20), dp(10))
            compoundDrawablePadding = dp(10)
            gravity = Gravity.CENTER_VERTICAL
            val icon = getDrawable(R.drawable.ic_wifi_off)!!.apply { setBounds(0, 0, dp(18), dp(18)) }
            setCompoundDrawablesRelative(icon, null, null, null)
            visibility = View.GONE
        }
        root.addView(noticeText, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            val margin = dp(if (isTv) 48 else 24)
            setMargins(margin, margin, margin, margin)
        })

        setContentView(root)
    }

    /**
     * The phone's controls, laid out like YouTube's: a round thumbnail, what's on and who's watching at the top left,
     * the party's icon buttons at the top right (long-press for a name), play/pause in the middle with previous and
     * next beside it in a binge, and the time, what's next and the seek bar along the bottom. All of it sits inside
     * the player's controls (phone_player_controls), so it shows and hides with them.
     */
    private fun buildPhoneControls() {
        playerView.findViewById<FrameLayout>(R.id.phone_top).addView(topBar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        topBar.background = null
        // Clear of a camera cutout at the side; the system bars are hidden while the video plays.
        padForCutout(topBar, dp(40), dp(14), dp(28), 0)
        padForCutout(playerView.findViewById(R.id.phone_bottom), dp(40), 0, dp(40), dp(8))

        posterView = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(SURFACE_HIGH) }
            clipToOutline = true
            visibility = View.GONE
        }
        topBar.addView(posterView, 0, LinearLayout.LayoutParams(dp(36), dp(36)).apply { marginEnd = dp(12) })
        titleText.apply {
            typeface = ResourcesCompat.getFont(this@RoomActivity, R.font.barlow_semibold)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            setTextColor(Color.WHITE)
        }
        membersText.apply {
            typeface = ResourcesCompat.getFont(this@RoomActivity, R.font.barlow_regular)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(Color.argb(200, 0xFF, 0xFF, 0xFF))
        }

        // A light dim over the whole picture, darker at the top and much darker at the bottom, so white reads anywhere.
        playerView.findViewById<View>(R.id.phone_shade).background = ShapeDrawable(RectShape()).apply {
            shaderFactory = object : ShapeDrawable.ShaderFactory() {
                override fun resize(width: Int, height: Int) = LinearGradient(
                    0f, 0f, 0f, height.toFloat(),
                    intArrayOf(Color.argb(170, 0, 0, 0), Color.argb(70, 0, 0, 0), Color.argb(70, 0, 0, 0), Color.argb(225, 0, 0, 0)),
                    floatArrayOf(0f, 0.3f, 0.55f, 1f),
                    Shader.TileMode.CLAMP,
                )
            }
        }
        upNextText = playerView.findViewById(R.id.phone_up_next)

        // The seek bar reaches out by half its dot at each end, so the line itself lines up with the time above it.
        playerView.findViewById<PhoneTimeBar>(androidx.media3.ui.R.id.exo_progress)?.let { bar ->
            (bar.layoutParams as ViewGroup.MarginLayoutParams).apply {
                marginStart = -bar.edgeInset
                marginEnd = -bar.edgeInset
            }
        }

        // Play/pause in a translucent dark circle, with previous and next beside it in a binge (host only).
        playerView.findViewById<View>(androidx.media3.ui.R.id.exo_play_pause).background = phoneControlBackground(CENTER_FILL)
        val center = playerView.findViewById<LinearLayout>(R.id.phone_center)
        prevButton = phoneButton("Previous", R.drawable.ic_skip_previous, CENTER_FILL) { bingeStep(-1)?.let { playForEveryone(it) } }.apply { visibility = View.GONE }
        nextButton = phoneButton("Next", R.drawable.ic_skip_next, CENTER_FILL) { bingeStep(1)?.let { playForEveryone(it) } }.apply { visibility = View.GONE }
        if (host) {
            center.addView(prevButton, 0, LinearLayout.LayoutParams(dp(48), dp(48)).apply { marginEnd = dp(CENTER_GAP_DP) })
            center.addView(nextButton, LinearLayout.LayoutParams(dp(48), dp(48)).apply { marginStart = dp(CENTER_GAP_DP) })
        }

        // The party's buttons; Media3's subtitle button joins them. Chat only is in Settings.
        val subtitles = playerView.findViewById<View>(androidx.media3.ui.R.id.exo_subtitle)
        (subtitles.parent as ViewGroup).removeView(subtitles)
        subtitles.background = phoneControlBackground(Color.TRANSPARENT)
        voiceButton = phoneButton("Join voice", R.drawable.ic_mic) { toggleVoice() }
        muteButton = phoneButton("Mute", R.drawable.ic_mic_off) { toggleMute() }.apply { visibility = View.GONE }
        val buttons = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        listOfNotNull(
            phoneButton("Invite friends", R.drawable.ic_user_plus) { if (solo) askInvite() else showInvite() },
            phoneButton("Chat", R.drawable.ic_chat) { openChat() }.also { chatButtons.add(it) },
            voiceButton,
            muteButton,
            subtitles,
            phoneButton("Up next", R.drawable.ic_video) { openUpNext() }.also { listButtons.add(it) },
            phoneButton("Settings", R.drawable.ic_settings) { showSettings() },
            // One button for both: leave alone, or (the host) end it for everyone.
            phoneButton("Leave", R.drawable.ic_leave) { confirmLeave() },
        ).forEach { buttons.addView(it, LinearLayout.LayoutParams(dp(48), dp(48))) }
        topBar.addView(buttons, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { marginStart = dp(8) })
    }

    /**
     * An icon button for the phone's player, drawn with the line icons (see [LINE_ICONS]): white on clear, or on
     * [fill] for the round buttons in the middle. A ripple shows the press; the name shows on long-press.
     */
    private fun phoneButton(label: String, icon: Int, fill: Int = Color.TRANSPARENT, onClick: () -> Unit) =
        barButton(label, icon, iconOnly = true, onClick).apply {
            lineIconSize[this] = PHONE_ICON_DP
            label(this, label, icon)
            background = phoneControlBackground(fill)
            compoundDrawableTintList = ColorStateList.valueOf(Color.WHITE)
        }

    /** A round background for the phone's player buttons: [fill], a lighter circle when focused, and a ripple. */
    private fun phoneControlBackground(fill: Int): RippleDrawable {
        fun circle(color: Int) = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }
        val content = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), circle(Color.argb(90, 255, 255, 255)))
            addState(intArrayOf(), circle(fill))
        }
        return RippleDrawable(ColorStateList.valueOf(Color.argb(64, 255, 255, 255)), content, circle(Color.WHITE))
    }

    /** Pads a view clear of a camera cutout, on top of the given padding. */
    private fun padForCutout(view: View, left: Int, top: Int, right: Int, bottom: Int) {
        view.setPadding(left, top, right, bottom)
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            v.setPadding(left + cutout.left, top + cutout.top, right + cutout.right, bottom + cutout.bottom)
            insets
        }
    }

    /**
     * Double-tap the left or right third of the phone's video to jump 10 seconds back or ahead, like YouTube; each
     * further tap on that side while the jump still shows adds 10 seconds more. The jumps go through
     * [PlayerSync.seekTo], so everyone in the party jumps too. A single tap still shows or hides the controls, and the
     * controls' own buttons and seek bar get their touches first.
     */
    private fun doubleTapSkips() {
        val detector = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true

            override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                playerView.performClick()
                return true
            }

            override fun onDoubleTap(e: MotionEvent): Boolean {
                val side = sideOf(e.x)
                if (side != 0) skipBy(side, adding = false)
                return true
            }
        })
        var streakTap = false
        playerView.setOnTouchListener { _, e ->
            if (e.actionMasked == MotionEvent.ACTION_DOWN) {
                streakTap = skipSide != 0 && SystemClock.uptimeMillis() < skipUntil && sideOf(e.x) == skipSide
            }
            if (!streakTap) {
                detector.onTouchEvent(e)
                return@setOnTouchListener true
            }
            when (e.actionMasked) {
                MotionEvent.ACTION_UP -> {
                    streakTap = false
                    skipBy(skipSide, adding = true)
                }
                MotionEvent.ACTION_CANCEL -> streakTap = false
            }
            true
        }
    }

    /** -1 for the left third of the video, 1 for the right third, 0 for the middle. */
    private fun sideOf(x: Float): Int = when {
        x < playerView.width / 3f -> -1
        x > playerView.width * 2 / 3f -> 1
        else -> 0
    }

    private fun skipBy(side: Int, adding: Boolean) {
        if (player.currentMediaItem == null) return
        skipSeconds = if (adding && side == skipSide) skipSeconds + (SKIP_MS / 1000).toInt() else (SKIP_MS / 1000).toInt()
        // A streak builds on where the last tap was headed, so each tap is exactly 10 s more.
        val from = if (adding && side == skipSide) skipTo else player.currentPosition
        skipSide = side
        skipUntil = SystemClock.uptimeMillis() + SKIP_STREAK_MS
        skipTo = (from + side * SKIP_MS).coerceIn(0L, player.duration.takeIf { it > 0 } ?: Long.MAX_VALUE)
        sync.seekTo(skipTo)
        skipRipple.show(forward = side > 0, seconds = skipSeconds, holdMs = SKIP_STREAK_MS)
    }

    /**
     * The TV's controls, laid out like YouTube on TV: what's on and who's watching at the top left, and along the
     * bottom the seek bar, the time and what's next, and one row of round icon buttons, playback on the left and the
     * party on the right. The buttons sit inside the player's controls, so they show and hide with them.
     */
    private fun buildTvControls() {
        topBar.setPadding(dp(48), dp(28), dp(48), dp(56))
        topBar.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(Color.argb(150, 0, 0, 0), Color.TRANSPARENT))
        posterView = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(SURFACE_HIGH) }
            clipToOutline = true
            visibility = View.GONE
        }
        topBar.addView(posterView, 0, LinearLayout.LayoutParams(dp(52), dp(52)).apply { marginEnd = dp(16) })
        titleText.apply {
            typeface = ResourcesCompat.getFont(this@RoomActivity, R.font.barlow_semibold)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
        }
        membersText.apply {
            typeface = ResourcesCompat.getFont(this@RoomActivity, R.font.barlow_regular)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            setTextColor(Color.argb(200, 0xFF, 0xFF, 0xFF))
        }

        // Dark along the bottom 45% or so, so the controls read over a bright picture.
        playerView.findViewById<View>(R.id.tv_shade).background = ShapeDrawable(RectShape()).apply {
            shaderFactory = object : ShapeDrawable.ShaderFactory() {
                override fun resize(width: Int, height: Int) = LinearGradient(
                    0f, 0f, 0f, height.toFloat(),
                    intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, Color.argb(150, 0, 0, 0), Color.argb(235, 0, 0, 0)),
                    floatArrayOf(0f, 0.55f, 0.75f, 1f),
                    Shader.TileMode.CLAMP,
                )
            }
        }
        upNextText = playerView.findViewById(R.id.tv_up_next)

        val left = playerView.findViewById<LinearLayout>(R.id.tv_left_buttons)
        // Previous and next in a binge, only while there is one.
        prevButton = tvButton("Previous", R.drawable.ic_skip_previous) { bingeStep(-1)?.let { playForEveryone(it) } }.apply { visibility = View.GONE }
        nextButton = tvButton("Next", R.drawable.ic_skip_next) { bingeStep(1)?.let { playForEveryone(it) } }.apply { visibility = View.GONE }
        if (host) {
            left.addView(prevButton)
            left.addView(nextButton)
        }

        // Media3's subtitle button joins the party's buttons; its audio and speed menu stays hidden at the end.
        val right = playerView.findViewById<LinearLayout>(R.id.tv_right_buttons)
        val subtitles = right.findViewById<View>(androidx.media3.ui.R.id.exo_subtitle)
        val playerSettings = right.findViewById<View>(androidx.media3.ui.R.id.exo_settings)
        right.removeAllViews()
        voiceButton = tvButton("Join voice", R.drawable.ic_mic) { toggleVoice() }
        muteButton = tvButton("Mute", R.drawable.ic_mic_off) { toggleMute() }.apply { visibility = View.GONE }
        listOfNotNull(
            tvButton("Chat", R.drawable.ic_chat) { openChat() }.also { chatButtons.add(it) },
            voiceButton,
            muteButton,
            subtitles,
            tvButton("Up next", R.drawable.ic_video) { openUpNext() }.also { listButtons.add(it) },
            tvButton("Settings", R.drawable.ic_settings) { showSettings() },
            tvButton("Invite friends", R.drawable.ic_user_plus) { askInvite() }.apply { visibility = View.GONE }.also { tvInvite = it },
            tvButton("Leave", R.drawable.ic_leave) { confirmLeave() },
            playerSettings,
        ).forEach { right.addView(it) }

        // Top to bottom: the seek bar, then the buttons. Up from any button goes to the bar; left and right on the bar move it.
        val progress = androidx.media3.ui.R.id.exo_progress
        playerView.findViewById<View>(progress)?.nextFocusDownId = androidx.media3.ui.R.id.exo_play_pause
        for (group in listOf(left, right)) {
            for (i in 0 until group.childCount) group.getChildAt(i).nextFocusUpId = progress
        }
    }

    /**
     * A round icon button for the TV's control row: just the icon, and while the remote is on it a white circle with
     * the icon dark, a little larger, as on Google TV. No label on screen; the name is for screen readers.
     */
    private fun tvButton(label: String, icon: Int, onClick: () -> Unit) = barButton(label, icon, iconOnly = true, onClick).apply {
        id = View.generateViewId()
        lineIconSize[this] = TV_ICON_DP
        label(this, label, icon)
        val focused = intArrayOf(android.R.attr.state_focused)
        background = StateListDrawable().apply {
            addState(focused, GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(FOCUS_FILL) })
            addState(intArrayOf(), ColorDrawable(Color.TRANSPARENT))
        }
        compoundDrawableTintList = ColorStateList(arrayOf(focused, intArrayOf()), intArrayOf(ON_ACCENT, Color.WHITE))
        layoutParams = LinearLayout.LayoutParams(dp(48), dp(48)).apply {
            marginStart = dp(4)
            marginEnd = dp(4)
        }
    }

    /** The player's line under the title (show, episode, party code, who's watching) and, in a binge, what's next. */
    private fun renderPlayerInfo() {
        val media = lastMedia
        val episode = media?.episode
        val names = members.map { it.name }.distinct().joinToString(", ")
        membersText.text = listOfNotNull(
            episode?.let { media?.meta?.show ?: it.show },
            episode?.let { episodeLabel(it.season, it.episode) },
            if (solo) "Watching alone" else "Party $roomCode",
            names.ifEmpty { null }.takeIf { !solo },
        ).joinToString(" · ")
        val items = queue?.items.orEmpty()
        val at = items.indexOfFirst { it.id == media?.id }
        val next = if (at < 0) null else items.getOrNull(at + 1)
        // "Up next: First Dance (S1 E2)": its name, and which episode, but not its place in the list.
        upNextText?.text = next?.let { n -> "Up next: ${playerTitle(n)}" + (n.episode?.let { " (${episodeLabel(it.season, it.episode)})" } ?: "") } ?: ""
    }

    private fun nothingPlaying(): String = when {
        solo -> "Nothing playing. Use Up next to pick something."
        host -> "Nothing playing. Use Up next to pick something. Friends join with code $roomCode."
        else -> "Waiting for the host to pick something."
    }

    /** The name the player shows: the episode's own name for an episode, when it's known. */
    private fun playerTitle(media: MediaItem): String = media.meta?.title ?: media.episode?.title ?: media.title

    /** The round thumbnail by the player's title: the episode's still, or the poster. */
    private fun loadPoster(media: MediaItem?) {
        val view = posterView ?: return
        posterFor = media?.id
        view.visibility = View.GONE
        val id = media?.id ?: return
        val path = media.meta?.let { it.stillPath ?: it.posterPath ?: it.showPosterPath } ?: return
        lifecycleScope.launch {
            val image = api.image(path, "w185") ?: return@launch
            if (posterFor != id) return@launch
            view.setImageBitmap(image.asAndroidBitmap())
            view.visibility = View.VISIBLE
        }
    }

    private fun showStatus(text: String) {
        statusText.text = text
        statusText.visibility = View.VISIBLE
    }

    private fun showMembers(members: List<Member>) {
        this.members = members
        renderPlayerInfo()
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
        label(voiceButton, "Leave voice", R.drawable.ic_mic_off)
        companionVoiceButton.visibility = if (chat.hasMic) View.GONE else View.VISIBLE
        label(companionVoiceButton, "Leave voice", R.drawable.ic_mic_off)
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
        companionVoiceButton.visibility = View.VISIBLE
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
                    m.id in brokenVoice -> Color.rgb(0xE0, 0x66, 0x66)
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
        // Rounded like the web's bubbles, with a tighter corner at the bottom on the sender's side.
        val r = dp(18).toFloat()
        val tail = dp(6).toFloat()
        val bubble = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(if (mine) ACCENT else otherColor)
                cornerRadii = if (mine) floatArrayOf(r, r, r, r, tail, tail, r, r) else floatArrayOf(r, r, r, r, r, r, tail, tail)
            }
            setPadding(dp(12), dp(7), dp(12), dp(8))
        }
        val maxText = (resources.displayMetrics.widthPixels * 0.75f).toInt().coerceAtMost(dp(280)) - dp(24)
        if (!mine && !run) {
            bubble.addView(text(12f, nameColor(m.from)).apply {
                text = m.from
                setTypeface(typeface, Typeface.BOLD)
                maxWidth = maxText
                setPadding(0, 0, 0, dp(2))
            }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        }
        bubble.addView(text(15f, if (mine) ON_ACCENT else Color.WHITE).apply {
            text = m.text
            maxWidth = maxText
            setLineSpacing(0f, 1.1f)
        }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        // WRAP_CONTENT: a vertical LinearLayout otherwise stretches each bubble to the full width.
        column.addView(bubble, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
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
        // The whole row takes focus and toggles, so the remote highlights it like the other rows.
        val popups = switch(prefs.chatPopups).apply { isFocusable = false }
        val row = dialogRow("Chat pop-ups", "Show new messages over the video on this device.", popups) { popups.toggle() }
        val save = {
            if (prefs.chatPopups != popups.isChecked) {
                prefs.chatPopups = popups.isChecked
                renderChatOverlay()
            }
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(row)
        }
        val settings = present(
            dialog()
                .setTitle("Settings")
                .setView(content)
                .setPositiveButton("Done") { _, _ -> save() }
                .setNegativeButton("Cancel", null),
        )
        /** A row that does something and closes Settings; [opens]: another menu, marked with a ›. */
        fun action(label: String, detail: String?, opens: Boolean = false, onClick: () -> Unit) = content.addView(
            dialogRow(label, detail, if (opens) chevron() else null) {
                save()
                settings.dismiss()
                onClick()
            },
        )
        action("Video quality", QUALITY_LABELS[prefs.videoQuality] ?: "Auto", opens = true) { showQuality() }
        // The player's controls have one gear, so Media3's own menu (audio track, playback speed) opens from here.
        action("Audio track and playback speed", null, opens = true) { openPlayerSettings() }
        // The phone's top row keeps to the essentials, so switching to chat only lives here.
        if (!isTv && !solo) action("Chat only", "Just chat on this phone, for when you're watching on a TV.") { enterCompanion(auto = false) }
        row.requestFocus()
    }

    /** Media3's audio track and speed menu, from its hidden button in the player's controls. */
    private fun openPlayerSettings() {
        playerView.showController()
        playerView.post { playerView.findViewById<View>(androidx.media3.ui.R.id.exo_settings)?.performClick() }
    }

    /** Shows the last few messages for 10 seconds each, like a game chat. */
    private fun renderChatOverlay() {
        val now = System.currentTimeMillis()
        val serverNow = sync.clock.serverNow(now)
        val recent = if (chatPanel.visibility == View.VISIBLE || !prefs.chatPopups || solo) emptyList()
        else chat.takeLast(6).filter { serverNow - it.ts < CHAT_FADE_MS }
        chatOverlay.removeAllViews()
        for (m in recent) {
            val age = serverNow - m.ts
            val view = text(14f, if (m.system) Color.LTGRAY else Color.WHITE).apply {
                text = formatMessage(m)
                background = GradientDrawable().apply {
                    setColor(OVERLAY_GRAY)
                    val r = dp(16).toFloat()
                    val tail = dp(6).toFloat()
                    cornerRadii = floatArrayOf(r, r, r, r, r, r, tail, tail)
                }
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
                setColor(Color.argb(150, 0x10, 0x10, 0x10))
                val r = dp(28).toFloat()
                cornerRadii = floatArrayOf(r, r, 0f, 0f, 0f, 0f, r, r)
            }
            visibility = View.GONE
            clipChildren = false
            clipToPadding = false
            val header = LinearLayout(this@RoomActivity).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(text(22f, ON_SURFACE).apply { text = "Chat"; typeface = MEDIUM }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                addView(barButton("Close", R.drawable.ic_close, iconOnly = true) { closeChat() })
                // Room for the focused button to grow without its circle being cut off.
                clipChildren = false
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
                addState(focused, pill(FOCUS_FILL))
                addState(intArrayOf(), pill(ACCENT))
            }
            stateListAnimator = null
            growOnFocus(this)
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
        companionTitle = text(22f, ON_SURFACE).apply {
            typeface = ResourcesCompat.getFont(this@RoomActivity, R.font.barlow_condensed_bold)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        companionWho = text(13f, ON_SURFACE_VARIANT).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        companionVoice = text(13f, ON_SURFACE).apply { visibility = View.GONE }
        companionHistory = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, dp(8)) }
        // Join voice sits in the header; once in, it gives way to Mute and Leave voice moves to the ⋮ menu.
        companionVoiceButton = barButton("Join voice", R.drawable.ic_mic) { toggleVoice() }
        companionMuteButton = barButton("Mute", R.drawable.ic_mic_off) { toggleMute() }.apply { visibility = View.GONE }
        companionProgress = View(this).apply { background = pill(ACCENT) }
        companionTime = text(12f, ON_SURFACE_VARIANT)
        companionLength = text(12f, ON_SURFACE_VARIANT)
        val input = chatInput()
        val send = { sendChat(input) }
        input.setOnEditorActionListener { _, actionId, _ -> sendOnAction(actionId, send) }
        lateinit var more: Button
        more = barButton("More", R.drawable.ic_more_vert, iconOnly = true) { showCompanionMenu(more) }
        // A thin track with the played part in amber, as on the web's running parties.
        val track = FrameLayout(this).apply {
            background = pill(SURFACE_HIGH)
            addView(companionProgress, FrameLayout.LayoutParams(0, MATCH_PARENT))
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(SURFACE)
            visibility = View.GONE
            // One slim header: logo, what's on and who's here, voice, and a ⋮ menu for the rest.
            addView(LinearLayout(this@RoomActivity).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(ComposeView(this@RoomActivity).apply { setContent { LogoMark(30.dp) } }, LinearLayout.LayoutParams(dp(30), dp(30)))
                addView(LinearLayout(this@RoomActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(companionTitle)
                    addView(companionWho)
                }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginStart = dp(10) })
                addView(companionVoiceButton)
                addView(companionMuteButton)
                addView(more)
            }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(10) })
            addView(View(this@RoomActivity).apply { setBackgroundColor(Color.argb(31, 0xB0, 0xA6, 0xBF)) }, LinearLayout.LayoutParams(MATCH_PARENT, dp(1)))
            addView(track, LinearLayout.LayoutParams(MATCH_PARENT, dp(4)).apply { topMargin = dp(10) })
            addView(LinearLayout(this@RoomActivity).apply {
                addView(companionTime, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                addView(companionLength)
            }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(4) })
            addView(companionVoice, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(6) })
            addView(ScrollView(this@RoomActivity).apply { isVerticalScrollBarEnabled = false; addView(companionHistory) }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f).apply { topMargin = dp(8) })
            addView(composer(input, send), LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(4) })
        }.also { view -> padForSystemBars(view, dp(16), dp(12), dp(16), dp(12)) }
    }

    /**
     * The ⋮ menu on the phone's chat screen, drawn as a Material 3 menu: a rounded raised surface just below
     * the button, with an icon on each row. (The platform PopupMenu still draws the old square gray menu.)
     */
    private fun showCompanionMenu(anchor: View) {
        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(8), 0, dp(8))
            minimumWidth = dp(200)
            background = GradientDrawable().apply { setColor(SURFACE_HIGH); cornerRadius = dp(16).toFloat() }
            clipToOutline = true
            elevation = dp(6).toFloat()
        }
        val popup = PopupWindow(list, WRAP_CONTENT, WRAP_CONTENT, true).apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            elevation = dp(6).toFloat()
        }
        fun item(label: String, icon: Int, onClick: () -> Unit) = list.addView(TextView(this).apply {
            text = label
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTextColor(ON_SURFACE)
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), 0, dp(24), 0)
            compoundDrawablePadding = dp(12)
            setCompoundDrawablesRelativeWithIntrinsicBounds(icon, 0, 0, 0)
            compoundDrawableTintList = ColorStateList.valueOf(ON_SURFACE_VARIANT)
            background = RippleDrawable(ColorStateList.valueOf(Color.argb(40, 255, 255, 255)), null, ColorDrawable(Color.WHITE))
            isFocusable = true
            setOnClickListener { popup.dismiss(); onClick() }
        }, LinearLayout.LayoutParams(MATCH_PARENT, dp(48)))
        item("Watch on this phone", R.drawable.ic_phone) { exitCompanion() }
        if (host || upNextQueue.value?.upcoming(lastMedia?.id)?.isNotEmpty() == true) item("Up next", R.drawable.ic_list_video) { openUpNext() }
        if (voice != null) item("Leave voice", R.drawable.ic_mic_off) { stopVoice() }
        item("Leave party", R.drawable.ic_leave) { confirmLeave() }
        popup.showAsDropDown(anchor, 0, dp(4), Gravity.END)
    }

    /** Who's here and how far along the video is, on the phone's chat screen. Runs once a second. */
    private fun renderCompanionStatus() {
        if (!companion) return
        // Your TV and phone share a name, so each person shows once.
        val names = members.map { it.name }.distinct()
        companionWho.text = if (names.isEmpty()) "On the TV" else "On the TV · " + names.joinToString(", ")
        val state = lastState
        val media = lastMedia
        if (state == null || media == null) {
            companionTime.text = ""
            companionLength.text = ""
            setCompanionProgress(0f)
            return
        }
        val position = state.expectedPosition(sync.clock.serverNow())
        val length = media.duration
        companionTime.text = clock(position) + if (state.paused) " · Paused" else " · Playing"
        companionLength.text = if (length != null && length > 0) clock(length) else ""
        setCompanionProgress(if (length != null && length > 0) (position / length).toFloat() else 0f)
    }

    private fun setCompanionProgress(fraction: Float) {
        val track = companionProgress.parent as View
        track.post {
            companionProgress.layoutParams = companionProgress.layoutParams.apply { width = (track.width * fraction.coerceIn(0f, 1f)).toInt() }
        }
    }

    private fun clock(seconds: Double): String {
        val s = seconds.toLong().coerceAtLeast(0)
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (h > 0) String.format("%d:%02d:%02d", h, m, sec) else String.format("%d:%02d", m, sec)
    }

    private fun enterCompanion(auto: Boolean) {
        if (companion) return
        companion = true
        connection.send(Protocol.player(false))
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
        renderCompanionStatus()
        if (auto) {
            Toast.makeText(this, "You're on the TV too, so this phone is now just chat. Use the ⋮ menu to watch here instead.", Toast.LENGTH_LONG).show()
        }
    }

    private fun exitCompanion() {
        if (!companion) return
        companion = false
        connection.send(Protocol.player(true))
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
            addState(focused, GradientDrawable().apply { setColor(BUBBLE_SOLID); cornerRadius = dp(22).toFloat(); setStroke(dp(2), FOCUS_FILL) })
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

    /** [back]: Back was pressed, rather than Leave. */
    private fun confirmLeave(back: Boolean = false) {
        // Watching alone, leaving saves the spot (Pick up where you left off). Leave goes straight away; Back asks first.
        if (solo) {
            val stop = {
                ended = true
                connection.send(Protocol.end(save = true))
                finish()
            }
            if (!back) return stop()
            present(
                dialog()
                    .setTitle("Stop watching?")
                    .setMessage("Your spot is saved, so you can pick up where you left off.")
                    .setPositiveButton("Stop watching") { _, _ -> stop() }
                    .setNegativeButton("Keep watching", null),
            )
            return
        }
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
                .setNeutralButton("End party") { _, _ -> endParty() }
                .setNegativeButton("Cancel", null),
            danger = AlertDialog.BUTTON_NEUTRAL,
        )
    }

    /** Watching alone or not: alone, there's no Chat or Join voice, Invite makes it a party, and there's no party code. */
    private fun setSolo(on: Boolean) {
        solo = on && host
        sync.alone = solo
        if (link != null) PartyLink.solo = solo
        val party = if (solo) View.GONE else View.VISIBLE
        chatButtons.forEach { it.visibility = party }
        if (voice == null) voiceButton.visibility = party
        tvInvite?.visibility = if (solo) View.VISIBLE else View.GONE
        renderPlayerInfo()
        if (lastMedia == null) titleText.text = nothingPlaying()
        renderChatOverlay()
    }

    /** Invite (watching alone): asks first, then makes it a party and shows the code (ui-redesign/solo/tv-invite-alone). */
    private fun askInvite() {
        present(
            dialog()
                .setTitle("Invite friends?")
                .setMessage("This turns your viewing into a party. Friends join with the code, chat and voice appear, and you keep your place.")
                .setPositiveButton("Make it a party") { _, _ -> makeParty() }
                .setNegativeButton("Cancel", null),
        )
    }

    private fun makeParty() {
        connection.send(Protocol.invite())
        setSolo(false)
        showInvite("It's a party")
    }

    /** The code and a QR of the invite link to scan; phones can also share or copy the link (a TV shows this only after Make it a party). */
    private fun showInvite(title: String = "Invite friends") {
        val link = inviteLink(prefs.serverUrl, roomCode)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(4), dp(24), 0)
            addView(text(36f, ON_SURFACE).apply {
                text = roomCode
                typeface = Typeface.create(MEDIUM, Typeface.BOLD)
                letterSpacing = 0.12f
            })
            addView(ImageView(this@RoomActivity).apply {
                setImageBitmap(qrBitmap(link).asAndroidBitmap())
                background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(12).toFloat() }
                setPadding(dp(10), dp(10), dp(10), dp(10))
            }, LinearLayout.LayoutParams(dp(if (isTv) 180 else 200), dp(if (isTv) 180 else 200)).apply { topMargin = dp(12) })
        }
        val builder = dialog()
            .setTitle(title)
            .setMessage("Friends join with this code, or by scanning the code with their phone.")
            .setView(content)
            .setPositiveButton("Done", null)
        if (!isTv) {
            builder.setNeutralButton("Copy link") { _, _ -> copyInvite(this, link) }
            builder.setNegativeButton("Share") { _, _ -> shareInvite(this, roomCode, link) }
        }
        present(builder)
    }

    /** Seconds into the video: the party's, on a phone that's only for chat. */
    private fun partyPosition(): Double =
        if (companion) lastState?.expectedPosition(sync.clock.serverNow(System.currentTimeMillis())) ?: 0.0
        else player.currentPosition / 1000.0

    /**
     * End party, from the Leave dialog. Partway through something, it asks "Save your spot?" (ui-redesign/resume) so
     * the party shows on Home under Pick up where you left off; otherwise it just ends.
     */
    private fun endParty() {
        val media = lastMedia
        val duration = media?.duration ?: player.duration.takeIf { !companion && it > 0 }?.let { it / 1000.0 }
        val position = partyPosition()
        val upcoming = queue?.upcoming(media?.id).orEmpty()
        if (media == null || !worthSaving(position, duration, upcoming.size, media.marks?.credits)) {
            connection.send(Protocol.end())
            return
        }
        val spot = spotPreview(media, position, duration, upcoming.firstOrNull(), upcoming.size)
        val message = SpannableStringBuilder("The party ends for everyone. Saving puts this on Home under ").apply {
            val start = length
            append("Pick up where you left off")
            setSpan(StyleSpan(Typeface.BOLD), start, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            setSpan(ForegroundColorSpan(ON_SURFACE), start, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            append(", so you can start a new party right here later.")
        }
        present(
            dialog()
                .setTitle("Save your spot?")
                .setMessage(message)
                .setView(spotView(spot))
                .setPositiveButton("Save spot") { _, _ -> connection.send(Protocol.end(save = true)) }
                .setNegativeButton("Don't save") { _, _ -> connection.send(Protocol.end()) }
                .setNeutralButton("Cancel", null),
        )
    }

    /** The video a saved spot would start: its picture with how far in, its name, and what's lined up after it. */
    private fun spotView(spot: SpotPreview): View {
        val m = spot.media
        val picture = FrameLayout(this).apply {
            background = GradientDrawable().apply { setColor(SURFACE); cornerRadius = dp(6).toFloat() }
            clipToOutline = true
        }
        val image = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        picture.addView(image, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        m.duration?.takeIf { it > 0 }?.let { d ->
            picture.addView(View(this).apply { setBackgroundColor(Color.argb(128, 0, 0, 0)) }, FrameLayout.LayoutParams(MATCH_PARENT, dp(3), Gravity.BOTTOM))
            val width = (dp(96) * (spot.position / d).coerceIn(0.0, 1.0)).toInt()
            picture.addView(View(this).apply { setBackgroundColor(ACCENT) }, FrameLayout.LayoutParams(width, dp(3), Gravity.BOTTOM or Gravity.START))
        }
        m.meta?.let { it.stillPath ?: it.backdropPath ?: it.posterPath }?.let { path ->
            lifecycleScope.launch { api.image(path, "w300")?.let { image.setImageBitmap(it.asAndroidBitmap()) } }
        }
        val words = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text(16f, ON_SURFACE).apply {
                text = m.episode?.let { m.meta?.title ?: it.title } ?: m.meta?.title ?: m.title
                typeface = MEDIUM
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            })
            addView(text(13f, ON_SURFACE_VARIANT).apply {
                text = listOfNotNull(m.episode?.let { "${m.meta?.show ?: it.show} · ${episodeLabel(it.season, it.episode)}" }, howFar(spot.position), linedUp(spot.more)).joinToString(" · ")
            })
        }
        val card = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(10), dp(10), dp(10))
            background = GradientDrawable().apply { setColor(Color.argb(13, 255, 255, 255)); cornerRadius = dp(14).toFloat() }
            addView(picture, LinearLayout.LayoutParams(dp(96), dp(54)))
            addView(words, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginStart = dp(14) })
        }
        return FrameLayout(this).apply {
            setPadding(dp(24), dp(8), dp(24), 0)
            addView(card)
        }
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

    private fun setQueue(q: Queue?) {
        queue = q
        upNextQueue.value = q
        if (link != null) PartyLink.queue = q
        updateBingeButtons()
        showMembers(members)
        val advance = q?.advance
        val next = advance?.let { a -> q.items.firstOrNull { it.id == a.mediaId } }
        if (next == null || companion) {
            hideNextCard()
            return
        }
        if (nextUp.value?.first?.id == next.id && nextUp.value?.second == advance.at) return
        // Over the video, which keeps playing (the credits, or the end): anyone can start it right away or stay on
        // this one; otherwise it starts by itself.
        nextUp.value = next to advance.at
        showSkip(null)
        nextCardView.visibility = View.VISIBLE
        // Chat pop-ups share the corner: lift them above the card.
        nextCardView.post { chatOverlay.translationY = -(nextCardView.height + dp(16)).toFloat() }
        if (isTv) {
            playerView.hideController()
            nextCardView.requestFocus()
        }
    }

    private fun hideNextCard() {
        if (nextUp.value == null) return
        val hadFocus = nextCardView.hasFocus()
        nextUp.value = null
        nextCardView.visibility = View.GONE
        chatOverlay.translationY = 0f
        if (hadFocus && isTv && !companion) playerView.requestFocus()
    }

    private fun buildNextCard() = ComposeView(this).also { nextCardView = it }.apply {
        visibility = View.GONE
        // Android's own gray focus box would show around the rounded shape; it draws its own focus.
        defaultFocusHighlightEnabled = false
        setContent {
            val up = nextUp.value
            if (up != null) PopcornTheme { Box(Modifier.padding(SHADOW_ROOM_DP.dp)) {
                NextCard(
                    api = api,
                    tv = isTv,
                    item = up.first,
                    at = up.second,
                    total = ADVANCE_MS,
                    focusKey = nextFocus.value,
                    serverNow = { sync.clock.serverNow(System.currentTimeMillis()) },
                    onPlayNow = { hideNextCard(); connection.send(Protocol.advanceNow()) },
                    onStay = { hideNextCard(); connection.send(Protocol.cancelAdvance()) },
                )
            } }
        }
    }

    private fun buildSkipView() = ComposeView(this).also { skipView = it }.apply {
        visibility = View.GONE
        // Android's own gray focus box would show around the rounded shape; it draws its own focus.
        defaultFocusHighlightEnabled = false
        setContent {
            val part = skipPart.value
            if (part != null) PopcornTheme { Box(Modifier.padding(SHADOW_ROOM_DP.dp)) {
                SkipPartButton(kind = part.first, tv = isTv, focusKey = skipFocus.value) {
                    sync.skip((part.second * 1000).toLong(), part.first)
                    showSkip(null)
                }
            } }
        }
    }

    /**
     * Four times a second: Skip intro / Skip recap while one is on (see ui-redesign/skip), and, crossing into the
     * credits while playing, the same report the end of the video makes, so Up next comes up there. Only crossing
     * counts (not joining or jumping in past them), and the server counts down once, whoever reports first.
     */
    private fun tickMarks() {
        if (companion || !::player.isInitialized || !::skipView.isInitialized) return
        val media = lastMedia?.takeIf { it.id == loadedMediaId }
        if (media?.id != lastTickMedia) {
            lastTickMedia = media?.id
            lastTick = -1.0
        }
        val t = player.currentPosition / 1000.0
        val part = if (nextUp.value == null && !upNextOpen.value) skippable(media?.marks, t) else null
        if (part != skipPart.value) showSkip(part)
        val credits = media?.marks?.credits
        if (media != null && credits != null && lastTick >= 0 && lastTick < credits && t >= credits && t - lastTick < 5 && player.isPlaying) {
            connection.send(Protocol.ended(media.id))
        }
        lastTick = t
    }

    private fun showSkip(part: Pair<String, Double>?) {
        if (!::skipView.isInitialized) return
        val hadFocus = skipView.hasFocus()
        val appeared = part != null && skipPart.value == null
        skipPart.value = part
        skipView.visibility = if (part != null) View.VISIBLE else View.GONE
        if (part == null && hadFocus && isTv) playerView.requestFocus()
        // Showing up with the controls already up: once it's laid out, just above the seek bar.
        if (appeared && isTv && playerView.isControllerFullyVisible) skipView.post { if (playerView.isControllerFullyVisible) skipView.translationY = -skipLift() }
        // The remote starts on it, so one OK skips, unless it's busy with the controls, chat or Up next.
        if (appeared && isTv && !playerView.isControllerFullyVisible && chatPanel.visibility != View.VISIBLE) skipFocus.value++
    }

    private fun updateBingeButtons() {
        updateListButtons()
        if (!::prevButton.isInitialized) return
        val inBinge = host && queue != null && !companion
        prevButton.visibility = if (inBinge) View.VISIBLE else View.GONE
        nextButton.visibility = if (inBinge) View.VISIBLE else View.GONE
        prevButton.isEnabled = bingeStep(-1) != null
        nextButton.isEnabled = bingeStep(1) != null
        prevButton.alpha = if (prevButton.isEnabled) 1f else 0.4f
        nextButton.alpha = if (nextButton.isEnabled) 1f else 0.4f
    }

    /**
     * Up next over the video (see ui-redesign/queue): a panel on the right of a TV, a bottom sheet on a phone. The
     * host plays, moves and removes videos there, and Add videos opens the library; guests just see what's coming.
     */
    private fun buildUpNextView() = ComposeView(this).also { upNextView = it }.apply {
        // Hidden while closed, so a TV remote can't land on it.
        visibility = View.GONE
        val screen = UpNextScreen(
            api = api,
            tv = isTv,
            code = roomCode,
            edit = if (host) ({ message: String -> connection.send(message) }) else null,
            position = ::partyPosition,
            onPlay = { item -> closeUpNext(); playForEveryone(item) },
            onAddVideos = { startActivity(Intent(this@RoomActivity, AddVideosActivity::class.java)) },
            onClose = ::closeUpNext,
        )
        setContent {
            if (upNextOpen.value) PopcornTheme { UpNext(screen, upNextQueue.value, upNextMedia.value) }
        }
    }

    private fun openUpNext() {
        playerView.hideController()
        upNextView.visibility = View.VISIBLE
        upNextOpen.value = true
    }

    private fun closeUpNext() {
        upNextOpen.value = false
        upNextView.visibility = View.GONE
        if (isTv && !companion) playerView.requestFocus()
    }

    /** Guests get the Up next button only when something is lined up; the host always has it, to add videos. */
    private fun updateListButtons() {
        val show = host || queue?.upcoming(lastMedia?.id)?.isNotEmpty() == true
        listButtons.forEach { it.visibility = if (show) View.VISIBLE else View.GONE }
    }

    // --- view helpers ---

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun text(sizeSp: Float, color: Int) = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        setTextColor(color)
    }

    /**
     * Media3's own focus mark on the play/pause, skip and seek-bar controls is a faint grey that's easy to lose from
     * the couch. Mark them as Google TV does: the focused button becomes a white circle with a dark icon and grows a
     * little. No colored outlines. TV only: the phone's buttons have their own look (phoneControlBackground).
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
                addState(focused, GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(FOCUS_FILL) })
                addState(intArrayOf(), GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.TRANSPARENT) })
            }
            if (button is ImageButton) button.imageTintList = ColorStateList(arrayOf(focused, intArrayOf()), intArrayOf(ON_ACCENT, Color.WHITE))
            growOnFocus(button)
        }
    }

    /**
     * The seek bar moves 10 s per press of the remote instead of Media3's default of 1/20 of the video
     * (90 s on a half-hour episode). The last control the remote was on is remembered for the next time the
     * controls appear.
     */
    private fun skipButtons() {
        (playerView.findViewById<View>(androidx.media3.ui.R.id.exo_progress) as? TimeBar)?.setKeyTimeIncrement(SEEK_BAR_STEP_MS)
        playerView.viewTreeObserver.addOnGlobalFocusChangeListener { _, focused ->
            if (focused != null && focused.id != View.NO_ID && focused !== playerView && isInside(focused, playerView)) {
                lastControlFocus = focused.id
            } else if ((focused == null || focused === playerView) && playerView.isControllerFullyVisible) {
                // A pressed control can lose focus (Media3 redraws it), leaving nothing marked while the controls
                // are up. Put the remote back on the control it was on.
                lastControlFocus?.let { id -> playerView.post { playerView.findViewById<View>(id)?.takeIf { it.isShown }?.requestFocus() } }
            }
        }
    }

    private fun isInside(view: View, parent: View): Boolean {
        var v: View? = view
        while (v != null) {
            if (v === parent) return true
            v = v.parent as? View
        }
        return false
    }

    /** Grows a view a little while a TV remote is on it, alongside its white focused background. */
    private fun growOnFocus(view: View) {
        val previous = view.onFocusChangeListener
        view.setOnFocusChangeListener { v, hasFocus ->
            previous?.onFocusChange(v, hasFocus)
            val scale = if (hasFocus) 1.1f else 1f
            v.animate().scaleX(scale).scaleY(scale).setDuration(120).start()
        }
    }

    /** A fully rounded shape, as Material 3 uses for buttons and chips. */
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
        // White marks the focused button (and it grows a little); no ring needed on top.
        background = StateListDrawable().apply {
            addState(focused, pill(FOCUS_FILL))
            addState(pressed, pill(ACCENT))
            addState(intArrayOf(), pill(TONAL))
        }
        growOnFocus(this)
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

    /** The player's buttons (TV and phone), which draw their icons as lines (see [LINE_ICONS]), and their icon size in dp. */
    private val lineIconSize = mutableMapOf<View, Int>()

    /** Sets a bar button's name and icon (voice and mute change theirs). */
    private fun label(button: Button, label: String, icon: Int) {
        val iconOnly = button.tag == true
        button.contentDescription = label
        button.tooltipText = label
        val lineIcon = lineIconSize[button]
        val size = lineIcon ?: 20
        val drawable = getDrawable(if (lineIcon != null) LINE_ICONS[icon] ?: icon else icon)!!.mutate().apply { setBounds(0, 0, dp(size), dp(size)) }
        button.setCompoundDrawablesRelative(drawable, null, null, null)
        if (iconOnly) {
            // Centered in the 48dp round button.
            button.text = ""
            button.compoundDrawablePadding = 0
            button.setPadding(dp((48 - size) / 2), 0, dp((48 - size) / 2), 0)
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
            addState(focused, track(SURFACE, FOCUS_FILL))
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

    /**
     * Shows a dialog in Material 3 dress (see ui-redesign/android/dialogs): a rounded 28dp surface, a 24sp headline,
     * and pill-shaped text buttons that turn white with dark text while a remote is on them, like the player's
     * controls. [danger] is a button (say, End party) that affects everyone, shown in a warm red.
     */
    private fun present(builder: AlertDialog.Builder, danger: Int? = null): AlertDialog = builder.show().apply {
        window?.setBackgroundDrawable(GradientDrawable().apply {
            setColor(SURFACE_HIGH)
            cornerRadius = dp(28).toFloat()
        })
        findViewById<TextView>(resources.getIdentifier("alertTitle", "id", "android"))?.apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            setTextColor(ON_SURFACE)
        }
        findViewById<TextView>(android.R.id.message)?.apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(ON_SURFACE_VARIANT)
            setLineSpacing(0f, 1.15f)
        }
        for (which in listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL)) {
            getButton(which)?.let { dialogButton(it, danger = which == danger) }
        }
        getButton(AlertDialog.BUTTON_POSITIVE)?.takeIf { it.visibility == View.VISIBLE }?.requestFocus()
    }

    private fun focusPill(radiusDp: Int) = StateListDrawable().apply {
        val pill = { color: Int -> GradientDrawable().apply { setColor(color); cornerRadius = dp(radiusDp).toFloat() } }
        addState(intArrayOf(android.R.attr.state_focused), pill(FOCUS_FILL))
        addState(intArrayOf(android.R.attr.state_pressed), pill(Color.argb(31, 255, 255, 255)))
        addState(intArrayOf(), ColorDrawable(Color.TRANSPARENT))
    }

    /** A dialog's text button: a 40dp pill that grows a little and turns white while focused. */
    private fun dialogButton(b: Button, danger: Boolean) = b.apply {
        isAllCaps = false
        typeface = MEDIUM
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        minWidth = 0
        minimumWidth = 0
        minHeight = dp(40)
        minimumHeight = dp(40)
        setPadding(dp(16), 0, dp(16), 0)
        stateListAnimator = null
        background = focusPill(20)
        setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(ON_ACCENT, if (danger) DANGER else ACCENT)))
        setOnFocusChangeListener { v, has -> v.animate().scaleX(if (has) 1.06f else 1f).scaleY(if (has) 1.06f else 1f).setDuration(120).start() }
        (layoutParams as? ViewGroup.MarginLayoutParams)?.let { it.marginStart = dp(8); layoutParams = it }
        // The grown pill must not be cut off by the button bar or the dialog around it.
        var p = parent as? ViewGroup
        repeat(4) {
            p?.clipChildren = false
            p?.clipToPadding = false
            p = p?.parent as? ViewGroup
        }
    }

    /** A radio button's circle (Material 3): an amber ring and dot when picked, dark while its row is focused. */
    private fun radio(on: Boolean) = View(this).apply {
        isDuplicateParentStateEnabled = true
        fun circle(color: Int) = LayerDrawable(listOfNotNull(
            GradientDrawable().apply { shape = GradientDrawable.OVAL; setStroke(dp(2), color) },
            if (on) GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) } else null,
        ).toTypedArray()).apply { if (on) setLayerInset(1, dp(5), dp(5), dp(5), dp(5)) }
        background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), circle(ON_ACCENT))
            addState(intArrayOf(), circle(if (on) ACCENT else ON_SURFACE_VARIANT))
        }
        minimumWidth = dp(20)
        minimumHeight = dp(20)
    }

    /** The › at the end of a dialog row that opens something else. */
    private fun chevron() = text(20f, ON_SURFACE_VARIANT).apply {
        text = "›"
        isDuplicateParentStateEnabled = true
        setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(ON_ACCENT, ON_SURFACE_VARIANT)))
    }

    /** A row in a dialog's list (Settings, Play for everyone): a rounded pill, white with dark text while focused. */
    private fun dialogRow(label: String, detail: String?, trailing: View? = null, onClick: () -> Unit): LinearLayout {
        val focused = intArrayOf(android.R.attr.state_focused)
        return LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
            isFocusable = true
            background = focusPill(16)
            addView(LinearLayout(this@RoomActivity).apply {
                orientation = LinearLayout.VERTICAL
                isDuplicateParentStateEnabled = true
                addView(text(16f, ON_SURFACE).apply {
                    text = label
                    isDuplicateParentStateEnabled = true
                    setTextColor(ColorStateList(arrayOf(focused, intArrayOf()), intArrayOf(ON_ACCENT, ON_SURFACE)))
                })
                if (detail != null) addView(text(14f, ON_SURFACE_VARIANT).apply {
                    text = detail
                    isDuplicateParentStateEnabled = true
                    setTextColor(ColorStateList(arrayOf(focused, intArrayOf()), intArrayOf(ON_FOCUS_MUTED, ON_SURFACE_VARIANT)))
                })
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            if (trailing != null) addView(trailing, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { marginStart = dp(16) })
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { setMargins(dp(8), dp(2), dp(8), dp(2)) }
        }
    }

    companion object {
        const val EXTRA_ROOM = "room"
        const val EXTRA_HOST = "host"
        private const val CHAT_FADE_MS = 10_000L
        /** The player's line icons (TV and phone) in place of the filled ones elsewhere; voice and mute keep switching through these. */
        private val LINE_ICONS = mapOf(
            R.drawable.ic_chat to R.drawable.ic_tv_chat,
            R.drawable.ic_mic to R.drawable.ic_tv_mic,
            R.drawable.ic_mic_off to R.drawable.ic_tv_mic_off,
            R.drawable.ic_video to R.drawable.ic_list_video,
            R.drawable.ic_settings to R.drawable.ic_gear,
            R.drawable.ic_leave to R.drawable.ic_tv_power,
            R.drawable.ic_skip_previous to R.drawable.ic_tv_prev,
            R.drawable.ic_skip_next to R.drawable.ic_tv_next,
        )

        private const val TV_ICON_DP = 20
        private const val PHONE_ICON_DP = 24
        /** The phone's round play/pause, previous and next: translucent dark, so they read over any picture. */
        private val CENTER_FILL = Color.argb(115, 0, 0, 0)
        /** Between play/pause and previous or next on the phone. */
        private const val CENTER_GAP_DP = 48
        /** How far the remote's fast-forward and rewind buttons, and a double-tap on the phone, jump. */
        private const val SKIP_MS = 10_000L
        private const val PLAYED_SHOWN_MS = 2_000L
        private const val NOTICE_SHOWN_MS = 6_000L
        /** A wait for video that starts this soon after a jump is the jump's (SlowConnection gives those longer). */
        private const val JUMP_WAIT_MS = 1_500L
        private val QUALITY_LABELS = mapOf(VideoQuality.AUTO to "Auto", VideoQuality.ORIGINAL to "Original", VideoQuality.LIGHT to "Lighter (720p)")
        /** How long the server counts down before a binge's next video (its advanceDelayMs). */
        private const val ADVANCE_MS = 10_000L
        /** Room inside the Skip intro and Up next card views for the shadows they draw (see where they're added). */
        private const val SHADOW_ROOM_DP = 24
        /** How long after a double-tap jump another tap on that side adds 10 seconds more, as on YouTube. */
        private const val SKIP_STREAK_MS = 800L
        private const val SEEK_BAR_STEP_MS = 10_000L
        private const val DUCK_VOLUME = 0.3f
        private val OK_KEYS = setOf(
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
            KeyEvent.KEYCODE_BUTTON_SELECT, KeyEvent.KEYCODE_BUTTON_A,
        )
        /** How far Skip intro moves up while the controls show, if the seek bar hasn't been laid out to measure. */
        private const val TV_CONTROLS_DP = 96
        /** The space between Skip intro and the TV's seek bar line while the controls show. */
        private const val SKIP_GAP_DP = 20
        private val DPAD_KEYS = setOf(
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
            KeyEvent.KEYCODE_BUTTON_SELECT, KeyEvent.KEYCODE_BUTTON_A,
            KeyEvent.KEYCODE_DPAD_UP_LEFT, KeyEvent.KEYCODE_DPAD_UP_RIGHT,
            KeyEvent.KEYCODE_DPAD_DOWN_LEFT, KeyEvent.KEYCODE_DPAD_DOWN_RIGHT,
        )
        private const val CHAT_PANEL_DP = 320
        /** The app's muted orange, as on the home screen. */
        private val ACCENT = Color.rgb(0xE0, 0x9A, 0x62)
        // Material 3 dark roles, built around the muted orange on dusky plum (as on the web app).
        private val ON_ACCENT = Color.rgb(0x18, 0x13, 0x1F)
        /** What a TV remote is on: white, with dark text or icon (ON_ACCENT), as on Google TV. */
        private val FOCUS_FILL = Color.rgb(0xF2, 0xEE, 0xF7)
        /** Secondary text on a focused (white) row. */
        private val ON_FOCUS_MUTED = Color.rgb(0x5B, 0x50, 0x68)
        /** Buttons that affect everyone, such as End party. */
        private val DANGER = Color.rgb(0xF2, 0xA0, 0x8E)
        private val SURFACE = Color.rgb(0x18, 0x13, 0x1F)
        private val SURFACE_HIGH = Color.rgb(0x31, 0x28, 0x3E)
        private val TONAL = Color.argb(200, 0x23, 0x1C, 0x2D)
        private val ON_SURFACE = Color.rgb(0xEE, 0xEA, 0xF3)
        private val ON_SURFACE_VARIANT = Color.rgb(0xB0, 0xA6, 0xBF)
        private val MEDIUM: Typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        /** Other people's bubbles: solid on the phone's chat screen, see-through over the movie. */
        private val BUBBLE_SOLID = Color.rgb(0x31, 0x28, 0x3E)
        private val BUBBLE_SEE_THROUGH = Color.argb(150, 0x50, 0x50, 0x50)
        /** Chat over the movie is plain see-through gray, not the app's purple, so it doesn't tint the picture. */
        private val OVERLAY_GRAY = Color.argb(170, 0x26, 0x26, 0x26)
        private val NAME_COLORS = intArrayOf(
            Color.rgb(0x7C, 0xC4, 0xFF), Color.rgb(0x8E, 0xE0, 0x9B), Color.rgb(0xF4, 0x8F, 0xB1),
            Color.rgb(0xB3, 0x9D, 0xFF), Color.rgb(0x6F, 0xE0, 0xD6), Color.rgb(0xFF, 0xB0, 0x7A),
        )

        fun start(context: Context, roomId: String, host: Boolean = true) {
            context.startActivity(Intent(context, RoomActivity::class.java).putExtra(EXTRA_ROOM, roomId).putExtra(EXTRA_HOST, host))
        }
    }
}

/**
 * Puts the remote on the button in [view] (Skip intro / recap, or Up next's Play now). The view itself takes focus
 * first: when the button showed up with the controls already up (as when the player opens), it never had focus, and a
 * Compose focus request inside a view that doesn't have focus goes nowhere. Then [key] changing aims it at the button.
 */
internal fun focusCorner(view: View, key: MutableState<Int>) {
    view.requestFocus()
    key.value++
}

/** What sits over the bottom-right corner of the video for the remote to go to: Skip intro / recap, or the Up next card. */
internal enum class Corner { Skip, NextCard }

/**
 * Where Up goes from the TV's controls, when not to the next control: from their top row (the seek bar), to Skip
 * intro / Skip recap or the Up next card while one shows, unless chat or the Up next list is open. Null leaves the
 * press to Android (and to [RoomActivity.dispatchKeyEvent]'s other rules).
 */
internal fun upFromControlsGoesTo(
    keyCode: Int,
    controlsShown: Boolean,
    onTopRow: Boolean,
    panelOpen: Boolean,
    skipShown: Boolean,
    nextShown: Boolean,
): Corner? {
    if (keyCode != KeyEvent.KEYCODE_DPAD_UP || !controlsShown || !onTopRow || panelOpen) return null
    return when {
        skipShown -> Corner.Skip
        nextShown -> Corner.NextCard
        else -> null
    }
}
