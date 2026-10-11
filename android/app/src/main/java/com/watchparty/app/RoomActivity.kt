package com.watchparty.app

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
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
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.annotation.OptIn
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
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

    private val main = Handler(Looper.getMainLooper())
    private val chat = mutableListOf<ChatMessage>()
    private var me: Member? = null
    private var loadedMediaId: String? = null
    private var chatDialogHistory: TextView? = null

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

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        player = ExoPlayer.Builder(this).build()
        sync = PlayerSync(player) { type, position -> connection.send(Protocol.position(type, position)) }
        buildLayout()
        playerView.player = player

        connection = RoomConnection(
            api.socketUrl(roomId, prefs.name),
            onMessage = ::onServerMessage,
            onStatus = ::onStatus,
        )
        connection.connect()
    }

    override fun onStart() {
        super.onStart()
        sync.start()
        main.post(chatTicker)
        playerView.requestFocus()
    }

    override fun onStop() {
        // Stop listening first so pausing here isn't broadcast as "paused" to everyone.
        sync.stop()
        player.playWhenReady = false
        main.removeCallbacks(chatTicker)
        super.onStop()
    }

    override fun onDestroy() {
        if (::connection.isInitialized) connection.close()
        if (::player.isInitialized) player.release()
        super.onDestroy()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_BUTTON_Y, KeyEvent.KEYCODE_PROG_BLUE -> {
                openChat()
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
                chat.clear()
                chat.addAll(msg.chat)
                showMembers(msg.members)
                applyState(msg.state, msg.media)
                renderChat()
            }
            is ServerMessage.State -> applyState(msg.state, msg.media)
            is ServerMessage.Members -> showMembers(msg.members)
            is ServerMessage.Chat -> {
                chat.add(msg.message)
                if (chat.size > 200) chat.removeAt(0)
                renderChat()
            }
            is ServerMessage.Pong -> sync.clock.onPong(msg.clientTime, msg.serverTime, System.currentTimeMillis())
            is ServerMessage.Error -> Toast.makeText(this, msg.message, Toast.LENGTH_SHORT).show()
        }
    }

    private fun onStatus(status: RoomConnection.Status) {
        when (status) {
            RoomConnection.Status.OPEN -> statusText.visibility = View.GONE
            RoomConnection.Status.CONNECTING -> showStatus("Connecting…")
            RoomConnection.Status.RECONNECTING -> showStatus("Reconnecting…")
            RoomConnection.Status.ROOM_GONE -> {
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
        titleText.text = media?.title ?: "Nothing playing. Use Change video to pick something."
        if (media != null && media.id != loadedMediaId) {
            loadedMediaId = media.id
            val subs = media.subtitles.map { track ->
                ExoMediaItem.SubtitleConfiguration.Builder(Uri.parse(api.subtitleUrl(media.id, track.index)))
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage(track.lang)
                    .setLabel(track.label)
                    .setSelectionFlags(if (track.index == 0) C.SELECTION_FLAG_DEFAULT else 0)
                    .build()
            }
            val item = ExoMediaItem.Builder()
                .setUri(api.streamUrl(media.id))
                .setMediaId(media.id)
                .setSubtitleConfigurations(subs)
                .build()
            player.setMediaItem(item)
            player.prepare()
        }
        sync.setState(state)
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
            })
        }
        root.addView(playerView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(24))
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.argb(200, 0, 0, 0), Color.TRANSPARENT),
            )
        }
        val titles = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        titleText = text(16f, Color.WHITE).apply { setTypeface(typeface, Typeface.BOLD); maxLines = 1 }
        membersText = text(13f, Color.LTGRAY).apply { maxLines = 1 }
        titles.addView(titleText)
        titles.addView(membersText)
        topBar.addView(titles, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        topBar.addView(barButton("Chat") { openChat() })
        topBar.addView(barButton("Change video") { pickVideo() })
        topBar.addView(barButton("Leave") { finish() })
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

        statusText = text(14f, Color.WHITE).apply {
            background = rounded(Color.argb(200, 24, 27, 34))
            setPadding(dp(14), dp(8), dp(14), dp(8))
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
        membersText.text = members.joinToString(", ") { it.name }
    }

    private fun renderChat() {
        renderChatOverlay()
        chatDialogHistory?.let { history ->
            history.text = chatHistoryText(50)
            (history.parent as? ScrollView)?.post { (history.parent as ScrollView).fullScroll(View.FOCUS_DOWN) }
        }
    }

    /** Shows the last few messages for 10 seconds each, like a game chat. */
    private fun renderChatOverlay() {
        val now = System.currentTimeMillis()
        val serverNow = sync.clock.serverNow(now)
        val recent = chat.takeLast(6).filter { serverNow - it.ts < CHAT_FADE_MS }
        chatOverlay.removeAllViews()
        for (m in recent) {
            val age = serverNow - m.ts
            val view = text(14f, if (m.system) Color.LTGRAY else Color.WHITE).apply {
                text = formatMessage(m)
                background = rounded(Color.argb(190, 10, 11, 14))
                setPadding(dp(10), dp(5), dp(10), dp(5))
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
        val color = if (m.from == me?.name) Color.rgb(124, 196, 255) else Color.rgb(229, 160, 13)
        return SpannableStringBuilder().apply {
            append(m.from)
            setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            setSpan(ForegroundColorSpan(color), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            append("  ")
            append(m.text)
        }
    }

    private fun chatHistoryText(limit: Int): CharSequence = SpannableStringBuilder().apply {
        chat.takeLast(limit).forEachIndexed { i, m ->
            if (i > 0) append("\n")
            append(formatMessage(m))
        }
    }

    private fun openChat() {
        val history = text(15f, Color.WHITE).apply { text = chatHistoryText(50) }
        val scroll = ScrollView(this).apply { addView(history) }
        val input = EditText(this).apply {
            hint = "Say something…"
            setSingleLine()
            imeOptions = EditorInfo.IME_ACTION_SEND
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(12), dp(20), 0)
            addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, dp(220)))
            addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        chatDialogHistory = history
        scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }

        val dialog = AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Chat")
            .setView(content)
            .setPositiveButton("Send", null)
            .setNegativeButton("Close", null)
            .create()

        val sendText = {
            val t = input.text.toString().trim()
            if (t.isNotEmpty()) connection.send(Protocol.chat(t))
            input.setText("")
        }
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND || actionId == EditorInfo.IME_ACTION_DONE) {
                sendText()
                true
            } else {
                false
            }
        }
        dialog.setOnShowListener {
            // Keep the dialog open after sending so you can keep chatting.
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { sendText() }
            input.requestFocus()
        }
        dialog.setOnDismissListener {
            chatDialogHistory = null
            playerView.requestFocus()
        }
        dialog.show()
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
            AlertDialog.Builder(this@RoomActivity, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Play for everyone")
                .setItems(labels) { _, which -> connection.send(Protocol.select(items[which].id)) }
                .setNegativeButton("Cancel", null)
                .show()
        }
    }

    // --- view helpers ---

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun text(sizeSp: Float, color: Int) = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        setTextColor(color)
    }

    private fun rounded(color: Int) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(8).toFloat()
    }

    private fun barButton(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { marginStart = dp(8) }
    }

    companion object {
        const val EXTRA_ROOM = "room"
        private const val CHAT_FADE_MS = 10_000L

        fun start(context: Context, roomId: String) {
            context.startActivity(Intent(context, RoomActivity::class.java).putExtra(EXTRA_ROOM, roomId))
        }
    }
}
