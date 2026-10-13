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
    fun readsInviteLinks() {
        val link = "https://tv.example.ts.net/join/ABC123"
        assertEquals("https://tv.example.ts.net", Prefs.normalizeUrl(link))
        assertEquals("abc123", Prefs.roomCode(link))
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
        // Already nudging: keep going until nearly exact.
        assertEquals(DriftAction.Rate(0.95f), Drift.decide(current = 20.1, target = 20.0, nudging = true))
        assertEquals(DriftAction.Rate(1f), Drift.decide(current = 20.03, target = 20.0, nudging = true))
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
        assertEquals("""{"type":"play","position":3.5,"at":1700000000000}""", Protocol.position("play", 3.5, 1700000000000))
    }

    @Test
    fun parsesVoiceMessages() {
        val members = Protocol.parse("""{"type":"members","members":[{"id":"a","name":"Ann","voice":true,"muted":false},{"id":"b","name":"Ben"}]}""")
        assertTrue(members is ServerMessage.Members)
        members as ServerMessage.Members
        assertEquals(listOf(true, false), members.members.map { it.voice })
        assertEquals(listOf(false, true), members.members.map { it.muted })

        val peers = Protocol.parse("""{"type":"voice-peers","peers":["a","b"]}""")
        assertEquals(ServerMessage.VoicePeers(listOf("a", "b")), peers)

        val signal = Protocol.parse("""{"type":"signal","from":"a","data":{"sdp":{"type":"offer","sdp":"v=0"}}}""")
        assertTrue(signal is ServerMessage.Signal)
        assertEquals(Protocol.sdpSignal("offer", "v=0"), (signal as ServerMessage.Signal).data)

        assertEquals("""{"type":"voice","on":true,"muted":false}""", Protocol.voice(on = true, muted = false))
        assertEquals(
            """{"type":"signal","to":"b","data":{"candidate":{"candidate":"c","sdpMid":"0","sdpMLineIndex":0}}}""",
            Protocol.signal("b", Protocol.candidateSignal("c", "0", 0)),
        )
    }

    @Test
    fun speakingHoldsBrieflyAfterGoingQuiet() {
        val t = SpeakingTracker(threshold = 0.1, holdMs = 500)
        t.level("a", 0.5, 1000)
        t.level("b", 0.05, 1000)
        assertEquals(setOf("a"), t.changed(1000, setOf("a", "b")))
        assertNull(t.changed(1400, setOf("a", "b")))
        assertEquals(emptySet<String>(), t.changed(1600, setOf("a", "b")))
        t.level("b", 0.2, 1700)
        assertEquals(setOf("b"), t.changed(1700, setOf("a", "b")))
        // Someone who left voice stops counting even inside the hold window.
        assertEquals(emptySet<String>(), t.changed(1800, setOf("a")))
    }

    @Test
    fun parsesPartyEnded() {
        assertEquals(ServerMessage.Ended("Jake"), Protocol.parse("""{"type":"ended","by":"Jake"}"""))
        assertEquals("""{"type":"end"}""", Protocol.end())
    }

    @Test
    fun nudgeWatchNoticesWhenSpeedDoesNothing() {
        val watch = NudgeWatch()
        assertEquals(false, watch.stuck(-1.0, 0))
        assertEquals(false, watch.stuck(-1.0, 3_000))
        assertEquals(true, watch.stuck(-1.0, 4_000))
        watch.reset()
        // Closing the gap keeps it going.
        assertEquals(false, watch.stuck(-1.0, 10_000))
        assertEquals(false, watch.stuck(-0.85, 13_000))
        assertEquals(false, watch.stuck(-0.7, 16_000))
        assertEquals(false, watch.stuck(-0.69, 19_000))
        assertEquals(true, watch.stuck(-0.69, 20_000))
    }
}
