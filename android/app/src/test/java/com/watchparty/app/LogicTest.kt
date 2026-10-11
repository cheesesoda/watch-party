package com.watchparty.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LogicTest {
    @Test
    fun normalizesServerUrls() {
        assertEquals("http://192.168.1.5:8080", Prefs.normalizeUrl(" 192.168.1.5:8080/ "))
        assertEquals("https://tv.example.ts.net", Prefs.normalizeUrl("https://tv.example.ts.net/#/room/abc123"))
        assertEquals("", Prefs.normalizeUrl("  "))
    }

    @Test
    fun extractsRoomCodes() {
        assertEquals("abc123", Prefs.roomCode("http://host:8080/#/room/ABC123"))
        assertEquals("xyz", Prefs.roomCode(" XYZ "))
    }

    @Test
    fun expectedPositionAdvancesOnlyWhilePlaying() {
        val playing = PlaybackState("m", paused = false, position = 10.0, updatedAt = 1000)
        assertEquals(15.0, playing.expectedPosition(6000), 1e-9)
        assertEquals(10.0, playing.copy(paused = true).expectedPosition(6000), 1e-9)
    }

    @Test
    fun clockOffsetPrefersLowestLatencySample() {
        val clock = ClockOffset()
        clock.onPong(clientTime = 0, serverTime = 600, now = 400) // rtt 400, offset 400
        clock.onPong(clientTime = 1000, serverTime = 1550, now = 1100) // rtt 100, offset 500
        assertEquals(500L, clock.offsetMs)
    }

    @Test
    fun driftDecisions() {
        assertEquals(DriftAction.Seek(20.0), Drift.decide(current = 10.0, target = 20.0))
        assertEquals(DriftAction.Rate(1.05f), Drift.decide(current = 19.0, target = 20.0))
        assertEquals(DriftAction.Rate(0.95f), Drift.decide(current = 21.0, target = 20.0))
        assertEquals(DriftAction.Rate(1f), Drift.decide(current = 20.1, target = 20.0))
    }

    @Test
    fun parsesServerMessages() {
        val welcome = Protocol.parse(
            """{"type":"welcome","you":{"id":"1","name":"Ann"},"roomId":"abc","state":{"mediaId":null,"paused":true,"position":0,"updatedAt":5},""" +
                """"media":null,"members":[{"id":"1","name":"Ann"}],"chat":[{"id":"c","from":"","text":"Ann joined","ts":5,"system":true}],"serverTime":9}""",
        )
        assertTrue(welcome is ServerMessage.Welcome)
        welcome as ServerMessage.Welcome
        assertEquals("Ann", welcome.you.name)
        assertNull(welcome.media)
        assertTrue(welcome.chat.single().system)

        val state = Protocol.parse(
            """{"type":"state","state":{"mediaId":"m","paused":false,"position":12.5,"updatedAt":100},""" +
                """"media":{"id":"m","title":"Movie","relPath":"Movie.mp4","folder":"","size":1,"mime":"video/mp4","subtitles":[{"index":0,"label":"en","lang":"en"}]},"by":"Ben"}""",
        )
        assertEquals(12.5, (state as ServerMessage.State).state.position, 1e-9)
        assertEquals("en", state.media!!.subtitles.single().lang)

        assertNull(Protocol.parse("""{"type":"future-thing"}"""))
        assertEquals("""{"type":"seek","position":3.5}""", Protocol.position("seek", 3.5))
    }
}
