package com.watchparty.app

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Barlow for text, as on cheesesoda.com and the web app. Bundled in the app (res/font), so nothing is downloaded. */
val Barlow = FontFamily(
    Font(R.font.barlow_regular, FontWeight.Normal),
    Font(R.font.barlow_medium, FontWeight.Medium),
    Font(R.font.barlow_semibold, FontWeight.SemiBold),
    Font(R.font.barlow_bold, FontWeight.Bold),
)

/** Barlow Condensed for headings. */
val BarlowCondensed = FontFamily(
    Font(R.font.barlow_condensed_semibold, FontWeight.SemiBold),
    Font(R.font.barlow_condensed_bold, FontWeight.Bold),
)

/** Material's type scale with every style in Barlow, so plain Text() and buttons pick it up. */
val BrandTypography: Typography = Typography().run {
    copy(
        displayLarge = displayLarge.copy(fontFamily = BarlowCondensed),
        displayMedium = displayMedium.copy(fontFamily = BarlowCondensed),
        displaySmall = displaySmall.copy(fontFamily = BarlowCondensed),
        headlineLarge = headlineLarge.copy(fontFamily = BarlowCondensed),
        headlineMedium = headlineMedium.copy(fontFamily = BarlowCondensed),
        headlineSmall = headlineSmall.copy(fontFamily = BarlowCondensed),
        titleLarge = titleLarge.copy(fontFamily = BarlowCondensed),
        titleMedium = titleMedium.copy(fontFamily = Barlow),
        titleSmall = titleSmall.copy(fontFamily = Barlow),
        bodyLarge = bodyLarge.copy(fontFamily = Barlow),
        bodyMedium = bodyMedium.copy(fontFamily = Barlow),
        bodySmall = bodySmall.copy(fontFamily = Barlow),
        labelLarge = labelLarge.copy(fontFamily = Barlow),
        labelMedium = labelMedium.copy(fontFamily = Barlow),
        labelSmall = labelSmall.copy(fontFamily = Barlow),
    )
}

private val PuffOrange = Color(0xFFFF8E44)
private val PuffCoral = Color(0xFFFF5252)

/** The popcorn puff with a play button cut out, in the full brand orange-to-coral (drawn, so it's sharp at any size). */
@Composable
fun LogoMark(size: Dp = 32.dp) {
    Canvas(Modifier.size(size).graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)) {
        // Laid out on a 64-unit square, like the SVG mark.
        val u = this.size.minDimension / 64f
        val puff = Brush.linearGradient(listOf(PuffOrange, PuffCoral), start = Offset(6 * u, 0f), end = Offset(58 * u, 58 * u))
        listOf(Triple(19f, 28f, 15f), Triple(45f, 28f, 15f), Triple(32f, 16f, 16f), Triple(23f, 43f, 14f), Triple(41f, 43f, 14f))
            .forEach { (x, y, r) -> drawCircle(puff, radius = r * u, center = Offset(x * u, y * u)) }
        val play = Path().apply {
            moveTo(26 * u, 20 * u)
            lineTo(45 * u, 31 * u)
            lineTo(26 * u, 42 * u)
            close()
        }
        drawPath(play, Color.Black, blendMode = BlendMode.Clear)
    }
}

/** The mark and the app's name, for screen headers. */
@Composable
fun LogoTitle(fontSize: TextUnit = 28.sp, markSize: Dp = 32.dp) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        LogoMark(markSize)
        Text("Popcorn Club", fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = fontSize, color = Color.White)
    }
}
