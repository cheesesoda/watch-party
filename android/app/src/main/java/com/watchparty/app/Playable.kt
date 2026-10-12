package com.watchparty.app

import android.content.Context
import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaCodecList
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioCapabilities

/** What this device can decode. Kept behind an interface so [Playable.direct] can be unit tested. */
interface Decoders {
    /** A decoder for this video codec (ffprobe's name) at this size, optionally 10-bit. */
    fun video(codec: String, width: Int, height: Int, tenBit: Boolean): Boolean
    /** A decoder for this audio codec, or the TV or receiver takes it as is over HDMI. */
    fun audio(codec: String): Boolean
}

object Playable {
    /** Phones get the converted copy above this height: the screen gains nothing and the file is far bigger. */
    const val PHONE_MAX_HEIGHT = 1080
    /** Phones get the converted copy above this bitrate (bits per second); the copy is capped at 10 Mbps. */
    const val PHONE_MAX_BITRATE = 20_000_000L

    // Containers ExoPlayer opens on its own.
    private val CONTAINERS = listOf("mp4", "mov", "matroska", "webm")

    /**
     * Whether to stream the original file rather than the server's converted copy. TVs keep the original
     * whenever they can decode it; phones also switch for 4K, very large files and mobile data.
     */
    fun direct(info: MediaInfo, sizeBytes: Long, isTv: Boolean, metered: Boolean, decoders: Decoders): Boolean {
        if (!info.convert) return true
        if (!isTv && metered) return false
        if (CONTAINERS.none { it in info.container.split(",") }) return false
        val video = info.video
        if (video != null) {
            val tenBit = Regex("10|12").containsMatchIn(video.pixFmt)
            if (!decoders.video(video.codec, video.width, video.height, tenBit)) return false
            if (!isTv && video.height > PHONE_MAX_HEIGHT) return false
        }
        info.audio?.let { if (!decoders.audio(it.codec)) return false }
        if (!isTv && info.duration > 0 && sizeBytes * 8 / info.duration > PHONE_MAX_BITRATE) return false
        return true
    }
}

/** [Decoders] backed by the device's MediaCodec list. */
@OptIn(UnstableApi::class)
class DeviceDecoders(private val context: Context) : Decoders {
    private val codecs = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }

    override fun video(codec: String, width: Int, height: Int, tenBit: Boolean): Boolean {
        val mime = VIDEO_MIME[codec] ?: return false
        return codecs.any { info ->
            if (mime !in info.supportedTypes) return@any false
            val caps = info.getCapabilitiesForType(mime)
            val sizeOk = width <= 0 || height <= 0 || caps.videoCapabilities?.isSizeSupported(width, height) != false
            val depthOk = !tenBit || caps.profileLevels.any { it.profile in (TEN_BIT_PROFILES[codec] ?: emptySet()) }
            sizeOk && depthOk
        }
    }

    override fun audio(codec: String): Boolean {
        val mime = AUDIO_MIME[codec] ?: return false
        if (codecs.any { mime in it.supportedTypes }) return true
        val encoding = PASSTHROUGH[codec] ?: return false
        @Suppress("DEPRECATION")
        return AudioCapabilities.getCapabilities(context).supportsEncoding(encoding)
    }

    private companion object {
        val VIDEO_MIME = mapOf(
            "h264" to "video/avc",
            "hevc" to "video/hevc",
            "av1" to "video/av01",
            "vp9" to "video/x-vnd.on2.vp9",
            "vp8" to "video/x-vnd.on2.vp8",
            "mpeg2video" to "video/mpeg2",
        )
        val TEN_BIT_PROFILES = mapOf(
            "hevc" to setOf(CodecProfileLevel.HEVCProfileMain10, CodecProfileLevel.HEVCProfileMain10HDR10, CodecProfileLevel.HEVCProfileMain10HDR10Plus),
            "av1" to setOf(CodecProfileLevel.AV1ProfileMain10, CodecProfileLevel.AV1ProfileMain10HDR10, CodecProfileLevel.AV1ProfileMain10HDR10Plus),
            "vp9" to setOf(CodecProfileLevel.VP9Profile2, CodecProfileLevel.VP9Profile2HDR, CodecProfileLevel.VP9Profile2HDR10Plus),
            "h264" to setOf(CodecProfileLevel.AVCProfileHigh10),
        )
        val AUDIO_MIME = mapOf(
            "aac" to "audio/mp4a-latm",
            "mp3" to "audio/mpeg",
            "opus" to "audio/opus",
            "vorbis" to "audio/vorbis",
            "flac" to "audio/flac",
            "ac3" to "audio/ac3",
            "eac3" to "audio/eac3",
            "dts" to "audio/vnd.dts",
            "truehd" to "audio/true-hd",
        )
        val PASSTHROUGH = mapOf(
            "ac3" to C.ENCODING_AC3,
            "eac3" to C.ENCODING_E_AC3,
            "dts" to C.ENCODING_DTS,
            "truehd" to C.ENCODING_DOLBY_TRUEHD,
        )
    }
}
