package com.clip9.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View

/**
 * 连接页面板里那个 168dp 的大圆环（设计稿 `.ringwrap .ring`）。
 *
 * ⚠️★ 它**只画两笔画**：一圈暗轨道 + 一段按状态变色变长的弧。中心那块可点的圆
 * 不在这里（那是布局里叠上去的一个 `View`）—— 把中心也画进来的话
 * 「点它一下 = 启停服务端」这个交互就得在这个自定义 View 里再实现一遍手势与点击态，
 * 而 `FrameLayout` + 一个带 `?attr/selectableItemBackground` 的子 View 本来就免费给你这些。
 *
 * ⚠️★ 三段的长度不是随手调的：设计稿写的是 SVG 的 `stroke-dasharray`，
 * 而圆的周长是 `2πr`（r=52）≈ 326.7。三个状态分别是：
 * `24 303` ≈ 7.3%、`286 41` ≈ 87.5%、`109 218` ≈ 33.4% —— 下面三个常量就是这三个比例。
 * 改它们之前先回去看稿子：这三个数是**设计过的**（一小段 = 待命、几乎满圈 = 正在跑、
 * 三分之一 = 出事了），不要为了「好看」调成别的比例。
 *
 * ⚠️ 起始角写死 -90°（正上方），对应设计稿 CSS 里那句 `transform: rotate(-90deg)` ——
 * SVG 的弧默认从三点钟方向开始画，不转身的话整段弧的位置会整体偏 90°。
 *
 * ⚠️ 它不持有任何服务端状态：弧长与颜色都由外部（`MainActivity.refresh()`）算好传进来。
 */
class RingView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : View(context, attrs, defStyleAttr) {

    companion object {
        /** 未运行：一小段（设计稿 `24 303`）。 */
        const val ARC_IDLE = 0.07f

        /** 运行中：几乎满圈（设计稿 `286 41`）。 */
        const val ARC_LIVE = 0.875f

        /** 起不来：三分之一（设计稿 `109 218`）。 */
        const val ARC_BAD = 0.333f

        /** 轨道与弧的线宽（设计稿 `stroke-width:7`）。 */
        private const val STROKE_DP = 7f
    }

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        // ⚠️ 轨道用**平头**：整圈 360° 用圆头画的话，起点与终点会叠出一个小鼓包，
        // 在灰色轨道上是一处看得见的凸起。圆头只给那段弧用。
        strokeCap = Paint.Cap.BUTT
        strokeWidth = STROKE_DP * resources.displayMetrics.density
        color = context.getColor(R.color.console_ring_track)
    }

    private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        // ⚠️ 弧用**圆头**（设计稿 `stroke-linecap:round`）—— 那两端是圆的，正是稿子的样子。
        strokeCap = Paint.Cap.ROUND
        strokeWidth = STROKE_DP * resources.displayMetrics.density
    }

    /** 画弧用的矩形（每次 `onDraw` 按当前尺寸重算，不缓存 —— 尺寸会随旋转/分屏变）。 */
    private val bounds = RectF()

    private var fraction = 0f
    private var arcColor = 0

    /**
     * 设定这一拍该画多长、什么颜色。
     *
     * ⚠️★ 值与颜色**一起**传：分开两个 setter 的话，中间那一帧会是「新长度 + 旧颜色」
     * （比如从「未运行」切到「运行中」时先画出一段 87% 的**灰**弧）。
     * ⚠️ 值没变就直接返回：`refresh()` 每 700ms 跑一次，不挡的话每秒多两次无谓重绘。
     */
    fun setRing(fraction: Float, color: Int) {
        val clamped = fraction.coerceIn(0f, 1f)
        if (clamped == this.fraction && color == arcColor) return
        this.fraction = clamped
        this.arcColor = color
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        // ⚠️ 内缩半个线宽：不缩的话描边会以边界为中轴、有一半画到控件外面被裁掉，
        // 看上去就是「弧比轨道粗一圈」。
        val inset = trackPaint.strokeWidth / 2f
        bounds.set(inset, inset, width - inset, height - inset)

        canvas.drawArc(bounds, 0f, 360f, false, trackPaint)
        if (fraction <= 0f) return

        arcPaint.color = arcColor
        canvas.drawArc(bounds, -90f, fraction * 360f, false, arcPaint)
    }
}
