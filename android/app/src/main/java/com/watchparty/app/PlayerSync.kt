package com.watchparty.app

import android.os.Handler
import android.os.Looper
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
    private val send: (type: String, position: Double) -> Unit,
) {
    val clock = ClockOffset()
    private var state: PlaybackState? = null
    private val main = Handler(Looper.getMainLooper())

    private val ticker = object : Runnable {
        override fun run() {
            reconcile()
            main.postDelayed(this, 1000)
        }
    }

    private val listener = object : Player.Listener {
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            val s = state ?: return
            if (playWhenReady && s.paused) local("play")
            else if (!playWhenReady && !s.paused && player.playbackState != Player.STATE_ENDED) local("pause")
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            if (reason != Player.DISCONTINUITY_REASON_SEEK || state == null) return
            if (abs(newPosition.positionMs / 1000.0 - target()) > Drift.USER_SEEK) local("seek")
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == Player.STATE_READY) reconcile()
        }
    }

    fun start() {
        player.addListener(listener)
        main.post(ticker)
    }

    fun stop() {
        player.removeListener(listener)
        main.removeCallbacks(ticker)
    }

    fun setState(newState: PlaybackState) {
        state = newState
        reconcile()
    }

    /**
     * A seek the user asked for (the skip buttons, a remote's rewind key). The room is told first, so a sync
     * check can't pull the player back to the old spot before the seek is noticed.
     */
    fun seekTo(positionMs: Long) {
        val duration = player.duration.takeIf { it > 0 } ?: Long.MAX_VALUE
        val to = positionMs.coerceIn(0L, duration)
        state?.let { s ->
            state = s.copy(position = to / 1000.0, updatedAt = clock.serverNow())
            send("seek", to / 1000.0)
        }
        player.seekTo(to)
    }

    private fun target(): Double = state?.expectedPosition(clock.serverNow()) ?: 0.0

    private fun local(type: String) {
        val s = state ?: return
        val position = player.currentPosition / 1000.0
        val paused = if (type == "seek") s.paused else type == "pause"
        state = s.copy(paused = paused, position = position, updatedAt = clock.serverNow())
        send(type, position)
    }

    private fun reconcile() {
        val s = state ?: return
        if (s.mediaId == null) return
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
            if (abs(current - target) > 0.25) player.seekTo((target * 1000).toLong())
            return
        }

        when (val action = Drift.decide(current, target)) {
            is DriftAction.Seek -> {
                setSpeed(1f)
                player.seekTo((action.toSeconds * 1000).toLong())
            }
            is DriftAction.Rate -> setSpeed(action.speed)
            DriftAction.None -> Unit
        }
        if (!player.playWhenReady && player.playbackState != Player.STATE_ENDED) player.playWhenReady = true
    }

    private fun setSpeed(speed: Float) {
        if (player.playbackParameters.speed != speed) player.playbackParameters = PlaybackParameters(speed)
    }
}
