package com.watchparty.app

/** Clock offset estimation and drift decisions, kept free of Android types so they can be unit tested. */
class ClockOffset {
    private val samples = ArrayDeque<Pair<Long, Long>>() // rtt to offset
    var offsetMs: Long = 0
        private set

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
    const val SOFT = 0.3
    const val USER_SEEK = 1.0

    /** What to do when playing and [current] is off from [target] (both in seconds). */
    fun decide(current: Double, target: Double): DriftAction {
        val drift = current - target
        return when {
            kotlin.math.abs(drift) > HARD -> DriftAction.Seek(target)
            kotlin.math.abs(drift) > SOFT -> DriftAction.Rate(if (drift < 0) 1.05f else 0.95f)
            else -> DriftAction.Rate(1f)
        }
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
