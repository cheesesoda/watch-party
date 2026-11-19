package com.watchparty.app

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.net.Inet4Address
import java.net.InetAddress
import java.util.Locale

/**
 * Settings > Playback info: how the video is streaming to this device, in a corner over the picture, to tell a slow
 * connection from a heavy file (mockups/playback-info).
 */
data class PlaybackStats(
    /** "Original file", "Converted copy" or "Lighter copy (720p)". */
    val playing: String,
    val video: String?,
    val audio: String?,
    /** How this device reaches the server; null until it's looked up. */
    val route: String?,
    /** The player's estimate of the download speed (bits a second); null before it has one. */
    val downloadBps: Long?,
    val bufferedMs: Long,
    val waits: Int,
    val waitedMs: Long,
    val droppedFrames: Int,
)

/** A row of the panel: its name, value, and whether the value is a warning. */
data class InfoRow(val label: String, val value: String, val warn: Boolean = false)

fun playbackRows(s: PlaybackStats): List<InfoRow> = listOfNotNull(
    InfoRow("Playing", s.playing),
    s.video?.let { InfoRow("Video", it) },
    s.audio?.let { InfoRow("Audio", it) },
    InfoRow("Route", s.route ?: "Checking…"),
    InfoRow("Download speed", s.downloadBps?.let(::bitrate) ?: "Measuring…"),
    InfoRow("Buffered ahead", "${s.bufferedMs / 1000} s"),
    InfoRow("Waits (last 5 min)", if (s.waits == 0) "None" else "${s.waits} · ${(s.waitedMs + 500) / 1000} s in all", warn = s.waits > 0),
    InfoRow("Dropped frames", s.droppedFrames.toString()),
)

/** "8.4 Mbps" ("24 Mbps" when it's whole), or "850 kbps" below 1 Mbps. */
fun bitrate(bps: Long): String =
    if (bps >= 1_000_000) String.format(Locale.US, "%.1f", bps / 1_000_000.0).removeSuffix(".0") + " Mbps" else "${(bps + 500) / 1000} kbps"

/** "H.264" for "video/avc" and the like; the subtype otherwise. */
fun codecName(mime: String?): String? = when (mime) {
    null -> null
    "video/avc" -> "H.264"
    "video/hevc" -> "HEVC"
    "video/av01" -> "AV1"
    "video/x-vnd.on2.vp9" -> "VP9"
    "video/mpeg2" -> "MPEG-2"
    "audio/mp4a-latm" -> "AAC"
    "audio/ac3" -> "Dolby Digital"
    "audio/eac3", "audio/eac3-joc" -> "Dolby Digital Plus"
    "audio/true-hd" -> "Dolby TrueHD"
    "audio/vnd.dts", "audio/vnd.dts.hd" -> "DTS"
    "audio/opus" -> "Opus"
    "audio/mpeg" -> "MP3"
    "audio/flac" -> "FLAC"
    else -> mime.substringAfter('/').uppercase(Locale.US)
}

/** "1920×1080 · H.264 · 8.4 Mbps"; any part not known is left out. */
fun videoLine(width: Int, height: Int, mime: String?, bps: Long?): String? =
    listOfNotNull(if (width > 0 && height > 0) "$width×$height" else null, codecName(mime), bps?.takeIf { it > 0 }?.let(::bitrate))
        .joinToString(" · ").ifEmpty { null }

/** "English · AAC 5.1"; any part not known is left out. */
fun audioLine(language: String?, mime: String?, channels: Int): String? {
    val name = language?.takeIf { it.isNotBlank() && it != "und" }?.let { Locale.forLanguageTag(it).getDisplayLanguage(Locale.ENGLISH).ifBlank { null } }
    val layout = when (channels) {
        1 -> "mono"
        2 -> "stereo"
        6 -> "5.1"
        8 -> "7.1"
        in 3..Int.MAX_VALUE -> "$channels channels"
        else -> null
    }
    return listOfNotNull(name, listOfNotNull(codecName(mime), layout).joinToString(" ").ifEmpty { null }).joinToString(" · ").ifEmpty { null }
}

/**
 * How [host] is reached, from what it resolved to: a Tailscale address (100.64.0.0/10) means straight over Tailscale,
 * a private one the home network, and anything else the internet (through Tailscale Funnel for a ts.net name).
 */
fun routeOf(host: String, addresses: List<InetAddress>): String {
    val v4 = addresses.filterIsInstance<Inet4Address>().map { it.address }
    if (v4.any { (it[0].toInt() and 0xFF) == 100 && (it[1].toInt() and 0xC0) == 64 }) return "Tailscale (direct)"
    if (addresses.any { it.isSiteLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress }) return "Home network"
    return if (host.endsWith(".ts.net")) "Internet (Funnel)" else "Internet"
}

/** The waits for video of the last 5 minutes, for the panel. */
class WaitLog(private val windowMs: Long = 5 * 60_000L) {
    private val waits = ArrayDeque<Pair<Long, Long>>()

    /** A wait of [ms] ended at [now]. */
    fun add(now: Long, ms: Long) {
        waits.addLast(now to ms)
    }

    /** How many waits, and how long in all (ms), in the window up to [now]. */
    fun recent(now: Long): Pair<Int, Long> {
        while (waits.isNotEmpty() && now - waits.first().first > windowMs) waits.removeFirst()
        return waits.size to waits.sumOf { it.second }
    }
}

@Composable
fun PlaybackInfoPanel(rows: List<InfoRow>, tv: Boolean) {
    val shape = RoundedCornerShape(16.dp)
    val size = if (tv) 12.sp else 11.sp
    Column(
        Modifier
            .width(if (tv) 300.dp else 260.dp)
            .background(Color(0xC7100C15), shape)
            .border(1.dp, Color(0x14EEEAF3), shape)
            .padding(start = 18.dp, end = 18.dp, top = 14.dp, bottom = 10.dp),
    ) {
        Text("PLAYBACK INFO", color = Accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.2.sp, modifier = Modifier.padding(bottom = 6.dp))
        rows.forEachIndexed { i, row ->
            if (i > 0) HorizontalDivider(thickness = 1.dp, color = Color(0x0FEEEAF3))
            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(row.label, color = Muted, fontSize = size, lineHeight = 18.sp)
                Text(
                    row.value, color = if (row.warn) Color(0xFFF2C66D) else Color(0xFFEEEAF3), fontSize = size, lineHeight = 18.sp,
                    textAlign = TextAlign.End, modifier = Modifier.weight(1f),
                )
            }
        }
    }
}
