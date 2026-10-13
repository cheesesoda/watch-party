package com.watchparty.app

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import kotlin.math.abs

/**
 * Keeps an ExoPlayer in step with the room's PlaybackState. Same approach as web/src/sync.ts:
 * remote state is applied to the player, and player changes that disagree with the room state
 * are treated as the local user acting and sent to the server.
 */
class PlayerSync(
    private val player: Player,
    /** [at]: the server's clock when it happened here, or null before a ping has measured it. */
    private val send: (type: String, position: Double, at: Long?) -> Unit,
) {
    val clock = ClockOffset()
    private var state: PlaybackState? = null
    /** Our own play/pause/seeks the server hasn't echoed back yet, and when the last one went out. */
    private var unechoed = 0
    /** The hold this device last said it was ready for, so it says so once. */
    private var readyFor = ""

    private var lastSentAt = 0L
    private val main = Handler(Looper.getMainLooper())

    /**
     * A seek the player hasn't shown yet. ExoPlayer reports the new position, and often still "ready", the moment
     * it's asked to seek, so without this the TV told the room it had loaded a jump before it had.
     */
    private var seekPending = false
    private val seekTimeout = Runnable { seekLoaded() }

    /**
     * Paused on our own, ahead of the room, until the room reaches this spot (seconds). Used instead of seeking
     * straight to the room's spot, which leaves the player behind by however long it took to load.
     */
    private var waitUntil: Double? = null
    /** Whether the wait followed a jump, so starting will take [startLag]; resuming from a plain pause doesn't. */
    private var waitJumped = false
    /** How far ahead to jump when catching up; grows if loading takes longer. */
    private var lead = 2.0
    private val nudge = NudgeWatch()
    /** When this device last started playing after a jump, until it has measured how late it got going. */
    private var resumedAt = 0L
    private val check = Runnable { reconcile() }

    private val ticker = object : Runnable {
        override fun run() {
            reconcile()
            main.postDelayed(this, 1000)
        }
    }

    private val listener = object : Player.Listener {
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            val s = state ?: return
            if (waitUntil != null) return
            if (playWhenReady && s.paused) local("play")
            else if (!playWhenReady && !s.paused && player.playbackState != Player.STATE_ENDED) local("pause")
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            if (reason != Player.DISCONTINUITY_REASON_SEEK || state == null) return
            seekStarted()
            if (waitUntil != null) return
            val expected = target() + (state?.let { holdLead(it) } ?: 0.0)
            if (abs(newPosition.positionMs / 1000.0 - expected) > Drift.USER_SEEK) local("seek")
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == Player.STATE_READY) reconcile()
        }

        override fun onRenderedFirstFrame() {
            if (seekPending) seekLoaded()
        }
    }

    fun start() {
        player.addListener(listener)
        main.post(ticker)
    }

    fun stop() {
        player.removeListener(listener)
        main.removeCallbacks(ticker)
        main.removeCallbacks(seekTimeout)
        main.removeCallbacks(check)
    }

    /**
     * [mine] is true when the room changed because of something this device sent. The server echoes every change
     * back, and an echo can arrive after the next one has already gone out (double-tapping to jump several times),
     * so an echo is skipped while newer changes of ours are still on the way. Otherwise the player would jump
     * back to the earlier spot and the next jump would start from there.
     */
    fun setState(newState: PlaybackState, mine: Boolean = false) {
        if (mine && unechoed > 0 && SystemClock.uptimeMillis() - lastSentAt < ECHO_WAIT_MS) {
            unechoed--
            if (unechoed > 0) return
        } else {
            unechoed = 0
        }
        waitUntil = null
        nudge.reset()
        resumedAt = if (state?.hold == true && !newState.paused) SystemClock.uptimeMillis() else 0L
        state = newState
        reconcile()
    }

    private fun sent(type: String, position: Double) {
        unechoed++
        lastSentAt = SystemClock.uptimeMillis()
        send(type, position, sentAt())
    }

    /**
     * A seek the user asked for (the skip buttons, a remote's rewind key). The room is told first, so a sync
     * check can't pull the player back to the old spot before the seek is noticed.
     */
    fun seekTo(positionMs: Long) {
        val duration = player.duration.takeIf { it > 0 } ?: Long.MAX_VALUE
        val to = positionMs.coerceIn(0L, duration)
        state?.let { s ->
            state = held(s).copy(position = to / 1000.0, updatedAt = clock.serverNow())
            sent("seek", to / 1000.0)
        }
        waitUntil = null
        seek(minOf(to + (state?.let { (holdLead(it) * 1000).toLong() } ?: 0L), duration))
        reconcile()
    }

    /** A jump while playing holds everyone at the new spot until each screen has loaded it (the server decides when). */
    private fun held(s: PlaybackState): PlaybackState =
        if (s.hold || !s.paused) s.copy(paused = true, hold = true) else s

    private fun seek(ms: Long) {
        seekStarted()
        player.seekTo(ms)
    }

    private fun seekStarted() {
        seekPending = true
        main.removeCallbacks(seekTimeout)
        main.postDelayed(seekTimeout, SEEK_LOAD_MS)
    }

    private fun seekLoaded() {
        seekPending = false
        main.removeCallbacks(seekTimeout)
        reconcile()
    }

    /**
     * While held, wait this far past the spot. Some TVs start a second or so late after a jump (inferred: the sound
     * restarting), so waiting slightly ahead means they're in step once they get going instead of behind.
     */
    private fun holdLead(s: PlaybackState): Double = if (s.hold) startLag else 0.0

    /**
     * Enough loaded past the spot to keep playing once everyone starts. Showing the first frame isn't enough: the
     * TV said it was ready, everyone started, and it fell behind while it loaded the rest.
     */
    private fun bufferedEnough(): Boolean =
        player.totalBufferedDuration >= READY_BUFFER_MS ||
            (player.duration > 0 && player.bufferedPosition >= player.duration)

    private fun sentAt(): Long? = if (clock.measured) clock.serverNow() else null

    private fun target(): Double = state?.expectedPosition(clock.serverNow()) ?: 0.0

    private fun local(type: String) {
        val s = state ?: return
        val position = player.currentPosition / 1000.0
        val paused = if (type == "seek") s.paused else type == "pause"
        val now = if (type == "seek") held(s) else s.copy(paused = paused, hold = false)
        state = now.copy(position = position, updatedAt = clock.serverNow())
        sent(type, position)
        if (type == "seek") reconcile()
    }

    private fun reconcile() {
        val s = state ?: return
        if (s.mediaId == null) return
        if (waitUntil != null) {
            if (s.paused) waitUntil = null else return waitForRoom()
        }
        // Only correct once the player is loaded; while buffering the position is stale.
        if (player.playbackState != Player.STATE_READY && player.playbackState != Player.STATE_ENDED) {
            // Still honor pause so a paused room doesn't start playing when the buffer fills.
            if (s.paused && player.playWhenReady) player.playWhenReady = false
            if (!s.paused && !player.playWhenReady && player.playbackState == Player.STATE_BUFFERING) player.playWhenReady = true
            return
        }

        val duration = player.duration.takeIf { it > 0 }?.div(1000.0) ?: Double.MAX_VALUE
        val target = minOf(target(), duration)
        val current = player.currentPosition / 1000.0

        if (s.paused) {
            setSpeed(1f)
            if (player.playWhenReady) player.playWhenReady = false
            val spot = minOf(target + holdLead(s), duration)
            if (abs(current - spot) > PAUSED_TOLERANCE) {
                seek((spot * 1000).toLong())
            } else if (s.hold && player.playbackState == Player.STATE_READY && !seekPending) {
                if (!bufferedEnough()) {
                    main.removeCallbacks(check)
                    main.postDelayed(check, 250)
                    return
                }
                // Loaded the spot everyone is waiting at. Not counted as a change of ours: the server doesn't echo it.
                val key = "${s.updatedAt}:${s.position}"
                if (readyFor != key) {
                    readyFor = key
                    send("ready", target, null)
                }
            }
            return
        }

        if (!player.playWhenReady && player.playbackState != Player.STATE_ENDED) player.playWhenReady = true
        // The position reads as the new spot before it has loaded, so there's nothing to measure yet.
        if (seekPending) return
        val drift = current - target
        if (resumedAt > 0) {
            // Just started together after a jump: give it a moment to get going, then learn how late it started.
            if (SystemClock.uptimeMillis() - resumedAt < LAG_CHECK_MS) return
            resumedAt = 0L
            startLag = (startLag - drift).coerceIn(0.0, MAX_START_LAG)
        }
        when (val action = Drift.decide(current, target, nudging = player.playbackParameters.speed != 1f)) {
            is DriftAction.Seek -> return catchUp(current, target, duration, behind = true)
            is DriftAction.Rate -> {
                if (action.speed == 1f) {
                    nudge.reset()
                } else if (nudge.stuck(drift, SystemClock.uptimeMillis())) {
                    return catchUp(current, target, duration, behind = drift < 0)
                }
                setSpeed(action.speed)
            }
            DriftAction.None -> Unit
        }
    }

    /**
     * Gets back in step without changing speed: when behind, jump a little past the room and pause there until
     * it arrives; when ahead, just pause until it catches up.
     */
    private fun catchUp(current: Double, target: Double, duration: Double, behind: Boolean) {
        nudge.reset()
        setSpeed(1f)
        if (behind && target + lead >= duration) return seek((target * 1000).toLong())
        val at = if (behind) target + lead else current
        waitUntil = at
        waitJumped = behind
        player.playWhenReady = false
        if (behind) seek((at * 1000).toLong())
        waitForRoom()
    }

    private fun waitForRoom() {
        val at = waitUntil ?: return
        if (player.playbackState == Player.STATE_ENDED) {
            waitUntil = null
            return
        }
        if (player.playWhenReady) player.playWhenReady = false
        if (seekPending || player.playbackState != Player.STATE_READY) return
        // Start a little early to make up for how late this device gets going.
        val early = at - (if (waitJumped) startLag else 0.0) - target()
        main.removeCallbacks(check)
        if (early > 0.02) {
            main.postDelayed(check, (early * 1000).toLong().coerceAtMost(1000))
            return
        }
        // Loading took longer than the jump ahead allowed for, so allow more next time.
        if (-early > Drift.SOFT) lead = minOf(lead - early + 0.5, MAX_LEAD)
        waitUntil = null
        if (waitJumped) resumedAt = SystemClock.uptimeMillis()
        player.playWhenReady = true
    }

    private fun setSpeed(speed: Float) {
        if (player.playbackParameters.speed != speed) player.playbackParameters = PlaybackParameters(speed)
    }

    companion object {
        /** After this long without an echo, stop waiting for it (the message was dropped or refused). */
        private const val ECHO_WAIT_MS = 5_000L
        /** Stop waiting for a seek to show a frame after this long (audio-only files never do). */
        private const val SEEK_LOAD_MS = 3_000L
        private const val MAX_LEAD = 6.0
        /** Paused screens should show the same frame: about two frames at 24 fps. */
        private const val PAUSED_TOLERANCE = 0.08
        /** Long enough for a slow start to finish before measuring it. */
        private const val LAG_CHECK_MS = 3_000L
        private const val MAX_START_LAG = 4.0
        private const val READY_BUFFER_MS = 3_000L

        /** How late this device starts playing after a jump, in seconds. Saved between parties (see Prefs). */
        var startLag = 0.0
    }
}
