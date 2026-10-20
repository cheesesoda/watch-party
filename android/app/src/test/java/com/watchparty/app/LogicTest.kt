package com.watchparty.app

import kotlinx.serialization.json.Json
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
    fun upNextIsWhatComesAfterTheVideoPlayingNow() {
        fun item(id: String) = MediaItem(id = id, title = id, relPath = "$id.mp4")
        val queue = Queue(items = listOf(item("a"), item("b"), item("c"), item("d")), at = 1)
        assertEquals(listOf("c", "d"), queue.upcoming("b").map { it.id })
        // Older servers don't say where the party is; the video playing now says it.
        assertEquals(listOf("d"), queue.copy(at = null).upcoming("c").map { it.id })
        assertEquals(emptyList<MediaItem>(), queue.copy(at = -1).upcoming("x"))
        val msg = Protocol.parse("""{"type":"queue","queue":{"items":[{"id":"a","title":"A","relPath":"a.mp4"}],"at":0,"advance":null}}""")
        assertEquals(0, (msg as ServerMessage.QueueChanged).queue?.at)
    }

    @Test
    fun parsesWatchingAlone() {
        val welcome = Protocol.parse(
            """{"type":"welcome","you":{"id":"1","name":"Ann"},"roomId":"abc","state":{"mediaId":null,"paused":true,"position":0,"updatedAt":5},""" +
                """"media":null,"serverTime":9,"solo":true}""",
        ) as ServerMessage.Welcome
        assertTrue(welcome.solo)
        assertEquals(false, (Protocol.parse("""{"type":"solo","solo":false}""") as ServerMessage.Solo).solo)
        assertEquals("""{"type":"invite"}""", Protocol.invite())
    }

    @Test
    fun countsPlacesInUpNext() {
        assertEquals(listOf("1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"), listOf(1, 2, 3, 4, 11, 12, 13, 21, 22).map(::ordinal))
    }

    @Test
    fun writesUpNextMessages() {
        assertEquals("""{"type":"queue-add","mediaIds":["a","b"]}""", Protocol.queueAdd(listOf("a", "b")))
        assertEquals("""{"type":"queue-move","mediaId":"a","to":2}""", Protocol.queueMove("a", 2))
        assertEquals("""{"type":"binge","mediaIds":["a"]}""", Protocol.binge(listOf("a")))
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

    @Test
    fun savesSpotsOnlyPartwayThrough() {
        // Same rules as the server: past the first minute and not at the credits, or with more lined up.
        assertEquals(false, worthSaving(30.0, 3000.0, 0))
        assertEquals(true, worthSaving(600.0, 3000.0, 0))
        assertEquals(false, worthSaving(2950.0, 3000.0, 0))
        assertEquals(true, worthSaving(2950.0, 3000.0, 2))
        assertEquals(true, worthSaving(0.0, null, 1))
        assertEquals(true, worthSaving(90.0, null, 0))
        // In the credits (where the server found them start) counts as the end too.
        assertEquals(false, worthSaving(2700.0, 3000.0, 0, 2650.0))
        assertEquals(true, worthSaving(2600.0, 3000.0, 0, 2650.0))
        assertEquals(true, worthSaving(2700.0, 3000.0, 1, 2650.0))
        // At the credits, the spot is the start of the next one.
        fun ep(n: Int) = MediaItem(id = "e$n", title = "Ep $n", relPath = "e$n.mkv", duration = 3000.0, episode = EpisodeInfo("Severance", 2, n, "Ep $n"))
        assertEquals(SpotPreview(ep(4), 0.0, 1), spotPreview(ep(3), 2990.0, 3000.0, ep(4), 2))
        assertEquals(SpotPreview(ep(3), 1860.0, 2), spotPreview(ep(3), 1860.0, 3000.0, ep(4), 2))
        assertEquals("Severance · S2 E3 Ep 3", spotTitle(ep(3)))
        assertEquals("Severance S2 E3", spotShortTitle(ep(3)))
        assertEquals("31 m in", howFar(1860.0))
        assertEquals("From the start", howFar(0.0))
        assertNull(linedUp(0))
    }

    @Test
    fun saysWhenASpotWasSaved() {
        val zone = java.time.ZoneId.of("UTC")
        val now = java.time.ZonedDateTime.of(2026, 10, 14, 20, 0, 0, 0, zone).toInstant().toEpochMilli()
        val day = 86_400_000L
        assertEquals("Today", savedWhen(now - 3_600_000, now, zone))
        assertEquals("Yesterday", savedWhen(now - day, now, zone))
        assertEquals("last week", savedWhen(now - 9 * day, now, zone))
        assertEquals("3 weeks ago", savedWhen(now - 22 * day, now, zone))
        assertTrue(Protocol.end(save = true).contains("\"save\":true"))
        assertTrue(!Protocol.end().contains("save"))
    }

    @Test
    fun skipsIntrosAndRecapsWhileTheyreOn() {
        val marks = Json { ignoreUnknownKeys = true }.decodeFromString(
            MediaItem.serializer(),
            """{"id":"e1","title":"E1","relPath":"e1.mkv","marks":{"intro":{"start":60,"end":95.5},"recap":{"start":0,"end":40},"credits":2500}}""",
        ).marks
        assertEquals(2500.0, marks?.credits)
        assertEquals("recap" to 40.0, skippable(marks, 0.0))
        assertEquals(null, skippable(marks, 39.0))
        assertEquals(null, skippable(marks, 50.0))
        assertEquals("intro" to 95.5, skippable(marks, 60.0))
        assertEquals("intro" to 95.5, skippable(marks, 93.0))
        assertEquals(null, skippable(marks, 94.0))
        assertEquals(null, skippable(null, 70.0))
    }

    @Test
    fun switchesToTheLighterStreamAfterALongWaitOrTwoWaitsInFiveMinutes() {
        val slow = SlowConnection()
        assertTrue("short waits don't count", !slow.waited(1_500, jump = false, now = 0))
        assertTrue("a jump gets longer", !slow.waited(4_000, jump = true, now = 1_000))
        assertTrue(!slow.waited(3_000, jump = false, now = 10_000))
        assertTrue("the first was over 5 minutes ago", !slow.waited(3_000, jump = false, now = 10_000 + 6 * 60_000))
        assertTrue(slow.waited(6_000, jump = true, now = 11_000 + 6 * 60_000))
        assertTrue("one long wait is enough", SlowConnection().waited(10_000, jump = false, now = 0))
        assertEquals("http://h/api/media/m1/hls/light/index.m3u8", Api("http://h", "").hlsUrl("m1", light = true))
        assertTrue(Protocol.quality(light = true, auto = true).contains("\"auto\":true"))
    }
}
