package com.watchparty.app

/** Clock offset estimation and drift decisions, kept free of Android types so they can be unit tested. */
class ClockOffset {
    private val samples = ArrayDeque<Pair<Long, Long>>() // rtt to offset
    var offsetMs: Long = 0
        private set

    /** True once a ping has measured the offset. */
    val measured: Boolean get() = samples.isNotEmpty()

    fun onPong(clientTime: Long, serverTime: Long, now: Long) {
        val rtt = now - clientTime
        samples.addLast(rtt to (serverTime - (clientTime + rtt / 2)))
        if (samples.size > 10) samples.removeFirst()
        offsetMs = samples.minBy { it.first }.second
    }

    fun serverNow(now: Long = System.currentTimeMillis()): Long = now + offsetMs
}

sealed interface DriftAction {
    data object None : DriftAction
    data class Seek(val toSeconds: Double) : DriftAction
    data class Rate(val speed: Float) : DriftAction
}

object Drift {
    const val HARD = 1.5
    const val SOFT = 0.15
    /** Once nudging, keep at it until this close, so it doesn't settle just under [SOFT]. */
    const val SETTLED = 0.04
    const val USER_SEEK = 1.0

    /** What to do when playing and [current] is off from [target] (both in seconds). [nudging]: the speed is already off 1x. */
    fun decide(current: Double, target: Double, nudging: Boolean = false): DriftAction {
        val drift = current - target
        return when {
            kotlin.math.abs(drift) > HARD -> DriftAction.Seek(target)
            kotlin.math.abs(drift) > (if (nudging) SETTLED else SOFT) -> DriftAction.Rate(if (drift < 0) 1.05f else 0.95f)
            else -> DriftAction.Rate(1f)
        }
    }
}

/**
 * Notices when playing a little faster or slower isn't closing the gap. Some TVs ignore the speed (for example
 * when the sound goes straight to a receiver), so the player would stay a second behind for good.
 */
class NudgeWatch(private val graceMs: Long = 4_000, private val minGain: Double = 0.1) {
    private var since = -1L
    private var startDrift = 0.0

    /** Call on each check while nudging, with the drift in seconds. True once it hasn't shrunk by [minGain] in [graceMs]. */
    fun stuck(drift: Double, now: Long): Boolean {
        val gap = kotlin.math.abs(drift)
        if (since < 0 || gap <= startDrift - minGain) {
            since = now
            startDrift = gap
            return false
        }
        return now - since >= graceMs
    }

    fun reset() {
        since = -1L
    }
}

/** Turns audio levels (0..1) into who is talking, holding each person briefly so the ring doesn't flicker. */
class SpeakingTracker(private val threshold: Double = 0.03, private val holdMs: Long = 600) {
    private val lastLoud = HashMap<String, Long>()
    private var current: Set<String> = emptySet()

    fun level(id: String, level: Double, now: Long) {
        if (level > threshold) lastLoud[id] = now
    }

    /** Who is talking among [ids], or null if that hasn't changed since the last call. */
    fun changed(now: Long, ids: Set<String>): Set<String>? {
        lastLoud.keys.retainAll(ids)
        val next = lastLoud.filterValues { now - it < holdMs }.keys.toSet()
        if (next == current) return null
        current = next
        return next
    }
}

/** The choices under Settings > Video quality, as kept in [Prefs.videoQuality]. */
object VideoQuality {
    /** The original file, switching to the lighter stream if this device keeps waiting for video. */
    const val AUTO = "auto"
    const val ORIGINAL = "original"
    /** The server's lighter copy (720p, about 3 Mbps) for slow connections. */
    const val LIGHT = "light"
}

/**
 * Notices a device that keeps waiting for video, so Auto quality can switch it to the lighter stream: a wait of 10 s,
 * or two waits within 5 minutes. Short waits don't count, and a jump's wait gets longer, since loading a new spot
 * takes a moment on any connection.
 */
class SlowConnection {
    private val waits = ArrayDeque<Long>()

    /** A wait for video of [ms] ended at [now] (ms); [jump]: right after a jump. True when it's time to switch. */
    fun waited(ms: Long, jump: Boolean, now: Long): Boolean {
        if (ms >= LONG_MS) return true
        if (ms < if (jump) JUMP_MS else PLAYING_MS) return false
        while (waits.isNotEmpty() && now - waits.first() > WINDOW_MS) waits.removeFirst()
        waits.addLast(now)
        return waits.size >= COUNT
    }

    companion object {
        /** One wait this long is enough (also checked while it's still going). */
        const val LONG_MS = 10_000L
        const val PLAYING_MS = 2_000L
        const val JUMP_MS = 5_000L
        const val WINDOW_MS = 5 * 60_000L
        const val COUNT = 2
    }
}
