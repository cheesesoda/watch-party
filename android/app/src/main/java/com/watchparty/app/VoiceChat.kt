package com.watchparty.app

import android.content.Context
import android.media.AudioAttributes
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.RtpTransceiver.RtpTransceiverDirection
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Voice chat over WebRTC, with a direct connection to every other voice member, matching the
 * web client. The server only relays offers, answers and ICE candidates. Whoever joins voice
 * calls everyone already in it, so two members never send each other offers.
 *
 * Remote voices play through the WebRTC audio module on their own. Everything here runs on the
 * main thread; WebRTC callbacks are posted back to it.
 */
class VoiceChat(
    context: Context,
    iceServers: List<IceServer>,
    private val send: (String) -> Unit,
) {
    private class Peer(val pc: PeerConnection, val offerer: Boolean) {
        val pending = mutableListOf<IceCandidate>()
        var remoteSet = false
        var restarted = false
    }

    private val main = Handler(Looper.getMainLooper())
    private val audioModule: JavaAudioDeviceModule
    private val factory: PeerConnectionFactory
    private val rtcConfig: PeerConnection.RTCConfiguration
    private val peers = HashMap<String, Peer>()
    private val speaking = SpeakingTracker()
    private var source: AudioSource? = null
    private var track: AudioTrack? = null
    private var myId = ""
    private var muted = false
    private var stopped = false

    /** Ids of everyone talking right now, yourself included. */
    var onSpeaking: (Set<String>) -> Unit = {}

    /** The connection to a member broke (false) or came back (true). */
    var onPeerHealth: (String, Boolean) -> Unit = { _, _ -> }

    val hasMic: Boolean get() = track != null

    private val meter = object : Runnable {
        override fun run() {
            if (stopped) return
            measure()
            main.postDelayed(this, 200)
        }
    }

    init {
        initialize(context.applicationContext)
        // Play voices like media, not like a phone call, so they come out of the same speaker as the movie.
        audioModule = JavaAudioDeviceModule.builder(context.applicationContext)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .createAudioDeviceModule()
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioModule)
            .createPeerConnectionFactory()
        rtcConfig = PeerConnection.RTCConfiguration(
            iceServers.map { server ->
                PeerConnection.IceServer.builder(server.urls)
                    .setUsername(server.username ?: "")
                    .setPassword(server.credential ?: "")
                    .createIceServer()
            },
        ).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
    }

    /** Joins voice. Without [withMic] you can still hear everyone. */
    fun start(myId: String, withMic: Boolean) {
        this.myId = myId
        if (withMic) {
            val src = factory.createAudioSource(MediaConstraints())
            source = src
            track = factory.createAudioTrack("mic", src).apply { setEnabled(true) }
        }
        main.post(meter)
        send(Protocol.voice(on = true, muted = !hasMic))
    }

    fun stop() {
        if (stopped) return
        stopped = true
        main.removeCallbacksAndMessages(null)
        for (id in peers.keys.toList()) drop(id)
        send(Protocol.voice(on = false, muted = true))
        track?.dispose()
        source?.dispose()
        factory.dispose()
        audioModule.release()
        onSpeaking(emptySet())
    }

    fun setMuted(muted: Boolean) {
        this.muted = muted
        track?.setEnabled(!muted)
        send(Protocol.voice(on = true, muted = muted || !hasMic))
    }

    /** After a reconnect we have a new member id and everyone else dropped us; join voice again. */
    fun rejoin(myId: String) {
        for (id in peers.keys.toList()) drop(id)
        this.myId = myId
        send(Protocol.voice(on = true, muted = muted || !hasMic))
    }

    /** The server's list of members to call after we joined voice. */
    fun callAll(ids: List<String>) {
        for (id in ids) call(id, iceRestart = false)
    }

    /** Drops connections to members who left the room or voice. */
    fun syncMembers(members: List<Member>) {
        val inVoice = members.filter { it.voice }.map { it.id }.toSet()
        for (id in peers.keys.toList()) if (id !in inVoice) drop(id)
    }

    fun onSignal(from: String, data: JsonObject) {
        if (stopped) return
        val sdp = data["sdp"] as? JsonObject
        val candidate = data["candidate"] as? JsonObject
        when {
            sdp != null -> {
                val type = sdp["type"]?.jsonPrimitive?.contentOrNull
                val text = sdp["sdp"]?.jsonPrimitive?.contentOrNull ?: return
                if (type == "offer") answer(from, text)
                if (type == "answer") {
                    val peer = peers[from] ?: return
                    if (peer.pc.signalingState() != PeerConnection.SignalingState.HAVE_LOCAL_OFFER) return
                    peer.pc.setRemoteDescription(
                        Sdp(onSet = { main.post { remoteSet(peer) } }),
                        SessionDescription(SessionDescription.Type.ANSWER, text),
                    )
                }
            }
            candidate != null -> {
                val peer = peers[from] ?: return
                val text = candidate["candidate"]?.jsonPrimitive?.contentOrNull
                if (text.isNullOrBlank()) return
                val ice = IceCandidate(
                    candidate["sdpMid"]?.jsonPrimitive?.contentOrNull ?: "0",
                    candidate["sdpMLineIndex"]?.jsonPrimitive?.intOrNull ?: 0,
                    text,
                )
                if (peer.remoteSet) peer.pc.addIceCandidate(ice) else peer.pending.add(ice)
            }
        }
    }

    private fun call(id: String, iceRestart: Boolean) {
        val peer = peers[id] ?: create(id, offerer = true).also { p ->
            val mic = track
            val direction = if (mic != null) RtpTransceiverDirection.SEND_RECV else RtpTransceiverDirection.RECV_ONLY
            val transceiver = p.pc.addTransceiver(
                MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
                RtpTransceiver.RtpTransceiverInit(direction),
            )
            // Every connection shares the one mic track, so no connection may dispose it.
            if (mic != null) transceiver.sender.setTrack(mic, false)
        }
        if (iceRestart) peer.pc.restartIce()
        peer.pc.createOffer(
            Sdp(onCreated = { offer ->
                peer.pc.setLocalDescription(
                    Sdp(onSet = { main.post { signal(id, Protocol.sdpSignal("offer", offer.description)) } }),
                    offer,
                )
            }),
            MediaConstraints(),
        )
    }

    private fun answer(from: String, offer: String) {
        val peer = peers[from] ?: create(from, offerer = false)
        peer.remoteSet = false
        peer.pc.setRemoteDescription(
            Sdp(onSet = {
                main.post {
                    if (stopped) return@post
                    // The offer created our transceiver as receive-only; send on it too if we have a mic.
                    val transceiver = peer.pc.transceivers.firstOrNull()
                    val mic = track
                    if (transceiver != null && mic != null) {
                        transceiver.setDirection(RtpTransceiverDirection.SEND_RECV)
                        transceiver.sender.setTrack(mic, false)
                    }
                    peer.pc.createAnswer(
                        Sdp(onCreated = { answer ->
                            peer.pc.setLocalDescription(
                                Sdp(onSet = { main.post { signal(from, Protocol.sdpSignal("answer", answer.description)) } }),
                                answer,
                            )
                        }),
                        MediaConstraints(),
                    )
                    remoteSet(peer)
                }
            }),
            SessionDescription(SessionDescription.Type.OFFER, offer),
        )
    }

    private fun remoteSet(peer: Peer) {
        peer.remoteSet = true
        for (c in peer.pending) peer.pc.addIceCandidate(c)
        peer.pending.clear()
    }

    private fun create(id: String, offerer: Boolean): Peer {
        lateinit var peer: Peer
        val observer = object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                main.post {
                    signal(id, Protocol.candidateSignal(candidate.sdp, candidate.sdpMid, candidate.sdpMLineIndex))
                }
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                main.post {
                    if (stopped || peers[id] !== peer) return@post
                    when (newState) {
                        PeerConnection.PeerConnectionState.CONNECTED -> {
                            peer.restarted = false
                            onPeerHealth(id, true)
                        }
                        PeerConnection.PeerConnectionState.FAILED ->
                            // The caller gets one ICE restart before we report it broken.
                            if (peer.offerer && !peer.restarted) {
                                peer.restarted = true
                                call(id, iceRestart = true)
                            } else {
                                onPeerHealth(id, false)
                            }
                        else -> {}
                    }
                }
            }

            override fun onSignalingChange(newState: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onDataChannel(dataChannel: DataChannel) {}
            override fun onRenegotiationNeeded() {}
        }
        val pc = factory.createPeerConnection(rtcConfig, observer)
            ?: error("Couldn't create a voice connection.")
        peer = Peer(pc, offerer)
        peers[id] = peer
        return peer
    }

    private fun drop(id: String) {
        val peer = peers.remove(id) ?: return
        peer.pc.dispose()
        onPeerHealth(id, true)
    }

    private fun signal(to: String, data: JsonObject) {
        if (!stopped) send(Protocol.signal(to, data))
    }

    /** Reads audio levels from WebRTC stats: received audio per peer, and our own mic. */
    private fun measure() {
        val now = System.currentTimeMillis()
        for ((id, peer) in peers.toList()) {
            peer.pc.getStats { report ->
                var remote = 0.0
                var local = 0.0
                for (stats in report.statsMap.values) {
                    val level = (stats.members["audioLevel"] as? Number)?.toDouble() ?: continue
                    when (stats.type) {
                        "inbound-rtp" -> remote = maxOf(remote, level)
                        "media-source" -> local = maxOf(local, level)
                    }
                }
                main.post {
                    if (stopped) return@post
                    speaking.level(id, remote, now)
                    if (!muted && hasMic) speaking.level(myId, local, now)
                    publish(now)
                }
            }
        }
        publish(now)
    }

    private fun publish(now: Long) {
        speaking.changed(now, peers.keys + myId)?.let(onSpeaking)
    }

    private class Sdp(
        private val onCreated: (SessionDescription) -> Unit = {},
        private val onSet: () -> Unit = {},
    ) : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) = onCreated(sdp)
        override fun onSetSuccess() = onSet()
        override fun onCreateFailure(error: String?) {
            Log.w(TAG, "SDP create failed: $error")
        }

        override fun onSetFailure(error: String?) {
            Log.w(TAG, "SDP set failed: $error")
        }
    }

    companion object {
        private const val TAG = "VoiceChat"
        private var initialized = false

        private fun initialize(appContext: Context) {
            if (initialized) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions(),
            )
            initialized = true
        }
    }
}
