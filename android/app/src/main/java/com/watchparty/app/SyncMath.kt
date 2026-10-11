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
