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
