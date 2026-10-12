package com.watchparty.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayableTest {
    /** A phone that decodes H.264 and AAC but not DTS, like most. */
    private val phone = object : Decoders {
        override fun video(codec: String, width: Int, height: Int, tenBit: Boolean) = codec == "h264" && !tenBit
        override fun audio(codec: String) = codec == "aac"
    }
    private val tv = object : Decoders {
        override fun video(codec: String, width: Int, height: Int, tenBit: Boolean) = true
        override fun audio(codec: String) = true
    }

    private fun movie(audio: String = "aac", height: Int = 1080, convert: Boolean = true) = MediaInfo(
        container = "matroska,webm",
        duration = 7200.0,
        video = MediaInfo.Video("h264", height * 16 / 9, height, "yuv420p"),
        audio = MediaInfo.Audio(audio, 6),
        convert = convert,
    )

    private val gb = 1_000_000_000L

    @Test
    fun phoneSwitchesForSoundItCantDecode() {
        // 1080p H.264 with DTS-HD MA: the picture plays, the sound doesn't.
        assertFalse(Playable.direct(movie(audio = "dts"), 8 * gb, isTv = false, metered = false, decoders = phone))
        assertTrue(Playable.direct(movie(audio = "aac"), 8 * gb, isTv = false, metered = false, decoders = phone))
    }

    @Test
    fun tvKeepsTheOriginalWhenItCanDecodeIt() {
        assertTrue(Playable.direct(movie(audio = "dts", height = 2160), 60 * gb, isTv = true, metered = false, decoders = tv))
    }

    @Test
    fun phoneSwitchesFor4kHugeFilesAndMobileData() {
        assertFalse(Playable.direct(movie(height = 2160), 8 * gb, isTv = false, metered = false, decoders = tv))
        // 30 GB over two hours is about 33 Mbps.
        assertFalse(Playable.direct(movie(), 30 * gb, isTv = false, metered = false, decoders = tv))
        assertFalse(Playable.direct(movie(), 8 * gb, isTv = false, metered = true, decoders = tv))
    }

    @Test
    fun originalWhenTheServerCantConvert() {
        assertTrue(Playable.direct(movie(audio = "dts", convert = false), 8 * gb, isTv = false, metered = true, decoders = phone))
    }
}
