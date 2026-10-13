package com.watchparty.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.core.content.res.ResourcesCompat
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.DefaultTimeBar
import androidx.media3.ui.TimeBar

/**
 * The phone player's seek bar, like YouTube's: a thin line with rounded ends, the played part in amber, what's loaded
 * in light gray, and a small amber dot that grows while it's dragged. Media3's own bar does the touch handling (and
 * keeps Android's back gesture off it); this only draws it differently, since Media3 draws square ends.
 */
@OptIn(UnstableApi::class)
class PhoneTimeBar(context: Context, attrs: AttributeSet? = null) : DefaultTimeBar(context, attrs) {
    private val density = resources.displayMetrics.density
    private val enabledDot = resources.getDimensionPixelSize(R.dimen.phone_scrubber_enabled)
    private val draggedDot = resources.getDimensionPixelSize(R.dimen.phone_scrubber_dragged)

    /** How far in from each end Media3 starts the line, so the dot fits there (its scrubber padding). */
    val edgeInset = (maxOf(enabledDot, draggedDot) + 1) / 2

    private var duration = 0L
    private var position = 0L
    private var buffered = 0L
    private var scrubbing = false
    private var scrubPosition = 0L
    private val accent = context.getColor(R.color.accent)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rect = RectF()

    init {
        addListener(object : TimeBar.OnScrubListener {
            override fun onScrubStart(timeBar: TimeBar, position: Long) {
                scrubbing = true
                scrubPosition = position
                invalidate()
            }

            override fun onScrubMove(timeBar: TimeBar, position: Long) {
                scrubPosition = position
                invalidate()
            }

            override fun onScrubStop(timeBar: TimeBar, position: Long, canceled: Boolean) {
                scrubbing = false
                if (!canceled) this@PhoneTimeBar.position = position
                invalidate()
            }
        })
    }

    /**
     * Media3's controls give the bar a bottom margin to clear the row of buttons in its own layout, whenever its
     * compact mode switches; this layout has no such row, so the bar keeps its place under the time.
     */
    override fun setLayoutParams(params: ViewGroup.LayoutParams?) {
        (params as? ViewGroup.MarginLayoutParams)?.bottomMargin = 0
        super.setLayoutParams(params)
    }

    override fun setPosition(position: Long) {
        super.setPosition(position)
        this.position = position
    }

    override fun setBufferedPosition(bufferedPosition: Long) {
        super.setBufferedPosition(bufferedPosition)
        buffered = bufferedPosition
    }

    override fun setDuration(duration: Long) {
        super.setDuration(duration)
        this.duration = duration
    }

    override fun onDraw(canvas: Canvas) {
        // The same line Media3 measures touches against: inset by half the dot at each end, centered vertically.
        val left = paddingLeft + edgeInset.toFloat()
        val right = width - paddingRight - edgeInset.toFloat()
        if (right <= left) return
        val cy = paddingTop + (height - paddingTop - paddingBottom) / 2f
        val r = BAR_DP * density / 2
        val shown = if (scrubbing) scrubPosition else position
        fun x(ms: Long) = if (duration <= 0) left else left + (right - left) * (ms.toFloat() / duration).coerceIn(0f, 1f)

        rect.set(left, cy - r, right, cy + r)
        paint.color = UNPLAYED
        canvas.drawRoundRect(rect, r, r, paint)
        if (duration <= 0) return
        rect.right = maxOf(x(maxOf(buffered, shown)), left + 2 * r)
        paint.color = BUFFERED
        canvas.drawRoundRect(rect, r, r, paint)
        rect.right = maxOf(x(shown), left + 2 * r)
        paint.color = accent
        canvas.drawRoundRect(rect, r, r, paint)
        if (!isEnabled) return
        canvas.drawCircle(x(shown), cy, (if (scrubbing) draggedDot else enabledDot) / 2f, paint)
    }

    private companion object {
        const val BAR_DP = 4f
        val UNPLAYED = Color.argb(77, 255, 255, 255)
        val BUFFERED = Color.argb(179, 255, 255, 255)
    }
}

/**
 * What a double-tap on the phone's video shows, like YouTube: a light curved band over that third of the picture, with
 * a circular arrow and how far it jumped ("10 seconds", "20 seconds" as the taps add up). It fades once the taps stop.
 */
class SkipRipple(context: Context) : View(context) {
    private val density = resources.displayMetrics.density
    private var forward = false
    private var seconds = 0
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(46, 255, 255, 255) }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textAlign = Paint.Align.CENTER
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 15f, resources.displayMetrics)
        typeface = ResourcesCompat.getFont(context, R.font.barlow_semibold)
        setShadowLayer(4 * density, 0f, density, Color.argb(120, 0, 0, 0))
    }
    private val back = context.getDrawable(R.drawable.ic_rotate_ccw)!!.mutate()
    private val ahead = context.getDrawable(R.drawable.ic_rotate_cw)!!.mutate()
    private val oval = RectF()
    private val fadeOut = Runnable { animate().alpha(0f).setDuration(250).start() }

    init {
        alpha = 0f
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    /** Shows the jump on the left ([forward] false) or right, and fades it [holdMs] after the last call. */
    fun show(forward: Boolean, seconds: Int, holdMs: Long) {
        this.forward = forward
        this.seconds = seconds
        invalidate()
        removeCallbacks(fadeOut)
        animate().cancel()
        animate().alpha(1f).setDuration(100).start()
        postDelayed(fadeOut, holdMs)
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(fadeOut)
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0 || h <= 0) return
        // A tall oval reaching about a third of the way in, so its edge curves like YouTube's.
        if (forward) oval.set(w * 0.64f, -h * 0.4f, w * 1.3f, h * 1.4f) else oval.set(-w * 0.3f, -h * 0.4f, w * 0.36f, h * 1.4f)
        canvas.drawOval(oval, fill)

        val cx = if (forward) w * 0.82f else w * 0.18f
        val icon = (30 * density).toInt()
        val gap = 8 * density
        val metrics = label.fontMetrics
        val textHeight = metrics.descent - metrics.ascent
        val top = h / 2 - (icon + gap + textHeight) / 2
        val arrow = if (forward) ahead else back
        arrow.setBounds((cx - icon / 2f).toInt(), top.toInt(), (cx - icon / 2f).toInt() + icon, top.toInt() + icon)
        arrow.draw(canvas)
        canvas.drawText("$seconds seconds", cx, top + icon + gap - metrics.ascent, label)
    }
}
