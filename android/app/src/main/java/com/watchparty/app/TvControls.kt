package com.watchparty.app

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.util.AttributeSet
import android.util.TypedValue
import android.view.KeyEvent
import android.view.View
import androidx.annotation.OptIn
import androidx.core.content.res.ResourcesCompat
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.ui.TimeBar
import java.util.Formatter
import java.util.Locale
import java.util.concurrent.CopyOnWriteArraySet

/**
 * The TV player's seek bar, drawn like YouTube on TV: thin while the remote is elsewhere; selected, it gets taller
 * and shows an amber dot with a white ring and the time in a small bubble above it. Left and right move it a step at
 * a time, and Media3's controls seek once the presses stop, as with its own bar.
 */
@OptIn(UnstableApi::class)
class TvTimeBar(context: Context, attrs: AttributeSet? = null) : View(context, attrs), TimeBar {
    private val listeners = CopyOnWriteArraySet<TimeBar.OnScrubListener>()
    private val density = resources.displayMetrics.density
    private var duration = 0L
    private var position = 0L
    private var buffered = 0L
    private var keyTimeIncrement = C.TIME_UNSET
    private var keyCountIncrement = 20
    private var scrubbing = false
    private var scrubPosition = 0L
    /** 0 while the bar is thin, 1 while it's selected, animated in between. */
    private var selected = 0f
    private var selectAnimator: ValueAnimator? = null
    private val stopScrubbing = Runnable { stopScrubbing(canceled = false) }

    private val accent = context.getColor(R.color.accent)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val timePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textAlign = Paint.Align.CENTER
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 15f, resources.displayMetrics)
        typeface = ResourcesCompat.getFont(context, R.font.barlow_semibold)
    }
    private val formatBuilder = StringBuilder()
    private val formatter = Formatter(formatBuilder, Locale.getDefault())
    private val rect = RectF()

    init {
        isFocusable = true
    }

    override fun addListener(listener: TimeBar.OnScrubListener) {
        listeners.add(listener)
    }

    override fun removeListener(listener: TimeBar.OnScrubListener) {
        listeners.remove(listener)
    }

    override fun setKeyTimeIncrement(time: Long) {
        keyTimeIncrement = time
        keyCountIncrement = C.INDEX_UNSET
    }

    override fun setKeyCountIncrement(count: Int) {
        keyCountIncrement = count
        keyTimeIncrement = C.TIME_UNSET
    }

    override fun setPosition(position: Long) {
        if (this.position == position) return
        this.position = position
        invalidate()
    }

    override fun setBufferedPosition(bufferedPosition: Long) {
        if (buffered == bufferedPosition) return
        buffered = bufferedPosition
        invalidate()
    }

    override fun setDuration(duration: Long) {
        this.duration = duration
        if (scrubbing && duration <= 0) stopScrubbing(canceled = true)
        invalidate()
    }

    override fun getPreferredUpdateDelay(): Long {
        val widthDp = (width / density).toInt()
        return if (widthDp == 0 || duration <= 0) Long.MAX_VALUE else duration / widthDp
    }

    // No ads in a watch party.
    override fun setAdGroupTimesMs(adGroupTimesMs: LongArray?, playedAdGroups: BooleanArray?, adGroupCount: Int) {}

    override fun setEnabled(enabled: Boolean) {
        super.setEnabled(enabled)
        if (scrubbing && !enabled) stopScrubbing(canceled = true)
    }

    /** Left and right always stay on the bar (it spans the screen, so there's nothing beside it to move to). */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val step = keyStep()
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                if (isEnabled && step > 0 && scrubBy(if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT) -step else step)) {
                    removeCallbacks(stopScrubbing)
                    postDelayed(stopScrubbing, STOP_SCRUBBING_MS)
                }
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> if (scrubbing) {
                stopScrubbing(canceled = false)
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
        super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
        if (scrubbing && !gainFocus) stopScrubbing(canceled = false)
        selectAnimator?.cancel()
        selectAnimator = ValueAnimator.ofFloat(selected, if (gainFocus) 1f else 0f).apply {
            duration = 120
            addUpdateListener {
                selected = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(stopScrubbing)
        selectAnimator?.cancel()
        super.onDetachedFromWindow()
    }

    private fun keyStep(): Long = when {
        keyTimeIncrement != C.TIME_UNSET -> keyTimeIncrement
        duration > 0 && keyCountIncrement > 0 -> duration / keyCountIncrement
        else -> 0L
    }

    private fun scrubBy(delta: Long): Boolean {
        if (duration <= 0) return false
        val from = if (scrubbing) scrubPosition else position
        val to = (from + delta).coerceIn(0L, duration)
        if (to == from) return false
        scrubPosition = to
        if (!scrubbing) {
            scrubbing = true
            isPressed = true
            for (l in listeners) l.onScrubStart(this, to)
        } else {
            for (l in listeners) l.onScrubMove(this, to)
        }
        invalidate()
        return true
    }

    private fun stopScrubbing(canceled: Boolean) {
        removeCallbacks(stopScrubbing)
        if (!scrubbing) return
        scrubbing = false
        isPressed = false
        if (!canceled) position = scrubPosition
        for (l in listeners) l.onScrubStop(this, scrubPosition, canceled)
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val ring = 11 * density
        // Inset by the dot's size, so the dot fits at either end.
        val left = paddingLeft + ring + density
        val right = width - paddingRight - ring - density
        val cy = height - 10 * density
        val barHeight = (4 + 4 * selected) * density
        val r = barHeight / 2
        val shown = if (scrubbing) scrubPosition else position
        fun x(ms: Long) = if (duration <= 0) left else left + (right - left) * (ms.toFloat() / duration).coerceIn(0f, 1f)

        rect.set(left, cy - r, right, cy + r)
        paint.color = Color.argb((70 + 40 * selected).toInt(), 255, 255, 255)
        canvas.drawRoundRect(rect, r, r, paint)
        if (duration > 0) {
            rect.right = x(maxOf(buffered, shown))
            paint.color = Color.argb(130, 255, 255, 255)
            canvas.drawRoundRect(rect, r, r, paint)
            rect.right = x(shown)
            paint.color = accent
            canvas.drawRoundRect(rect, r, r, paint)
        }
        if (selected <= 0f) return

        val dotX = x(shown)
        paint.color = Color.WHITE
        paint.alpha = (255 * selected).toInt()
        canvas.drawCircle(dotX, cy, ring * selected, paint)
        paint.color = accent
        paint.alpha = (255 * selected).toInt()
        canvas.drawCircle(dotX, cy, 8 * density * selected, paint)

        // The time in a small dark bubble above the dot, kept on screen at either end.
        val time = Util.getStringForTime(formatBuilder, formatter, shown)
        val metrics = timePaint.fontMetrics
        val padX = 10 * density
        val padY = 4 * density
        val bubbleWidth = timePaint.measureText(time) + 2 * padX
        val bubbleHeight = metrics.descent - metrics.ascent + 2 * padY
        val bubbleLeft = (dotX - bubbleWidth / 2).coerceIn(0f, (width - bubbleWidth).coerceAtLeast(0f))
        val bubbleBottom = cy - ring - 6 * density
        rect.set(bubbleLeft, bubbleBottom - bubbleHeight, bubbleLeft + bubbleWidth, bubbleBottom)
        paint.color = Color.argb((235 * selected).toInt(), 0x10, 0x10, 0x14)
        canvas.drawRoundRect(rect, 6 * density, 6 * density, paint)
        timePaint.alpha = (255 * selected).toInt()
        canvas.drawText(time, rect.centerX(), rect.top + padY - metrics.ascent, timePaint)
    }

    companion object {
        /** As in Media3's own bar: the seek happens this long after the last press. */
        private const val STOP_SCRUBBING_MS = 1000L
    }
}
