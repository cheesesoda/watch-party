import type { ClientMessage, IceServer, Member, SignalData } from "../../shared/protocol.ts";

/** RMS level above which someone counts as talking. */
const SPEAKING_LEVEL = 0.02;
/** How long someone keeps counting as talking after they go quiet. */
const SPEAKING_HOLD_MS = 600;

interface Peer {
  pc: RTCPeerConnection;
  /** True if we sent the offer; only the offerer restarts ICE, so the two sides never both try. */
  offerer: boolean;
  audio: HTMLAudioElement;
  pending: RTCIceCandidateInit[];
  meter?: Meter;
}

interface Meter {
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  lastLoud: number;
}

export type VoiceStatus = "off" | "starting" | "on";

/**
 * Voice chat over WebRTC, with a direct connection to every other voice member.
 * The server only relays offers, answers and ICE candidates. Whoever joins voice
 * calls everyone already in it, so two members never send each other offers.
 */
export class Voice {
  private peers = new Map<string, Peer>();
  private mic: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private localMeter: Meter | null = null;
  private meterTimer: number | undefined;
  private speaking = new Set<string>();
  private muted = false;
  private myId = "";

  /** Called with the ids of everyone currently talking (yourself included). */
  onSpeaking: (ids: Set<string>) => void = () => {};
  /** Called when the connection to a member breaks (false) or comes back (true). */
  onPeerHealth: (id: string, ok: boolean) => void = () => {};

  constructor(
    private send: (msg: ClientMessage) => void,
    private iceServers: IceServer[],
  ) {}

  get hasMic(): boolean {
    return this.mic !== null;
  }

  /**
   * Joins voice. Asks for the mic if the page allows it; without one you can still listen.
   * Returns why there is no mic, or null if there is one.
   */
  async start(myId: string, muted: boolean): Promise<string | null> {
    this.myId = myId;
    this.muted = muted;
    this.ctx = new AudioContext();
    let problem: string | null = null;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      problem = "Browsers only allow the mic over HTTPS, so you are listening only.";
    } else {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.applyMute();
        this.localMeter = this.meter(this.mic);
      } catch {
        problem = "No mic available (or permission was denied), so you are listening only.";
      }
    }
    this.meterTimer = window.setInterval(() => this.measure(), 100);
    this.send({ type: "voice", on: true, muted: this.muted || !this.mic });
    return problem;
  }

  stop(): void {
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.localMeter = null;
    window.clearInterval(this.meterTimer);
    void this.ctx?.close();
    this.ctx = null;
    this.setSpeaking(new Set());
    this.send({ type: "voice", on: false, muted: true });
  }

  /** After a reconnect we have a new member id and everyone else dropped us; join voice again. */
  rejoin(myId: string): void {
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.myId = myId;
    this.send({ type: "voice", on: true, muted: this.muted || !this.mic });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMute();
    this.send({ type: "voice", on: true, muted: muted || !this.mic });
  }

  /** The server's list of members to call after we joined voice. */
  callAll(ids: string[]): void {
    for (const id of ids) void this.call(id);
  }

  /** Drops connections to members who left the room or voice. */
  syncMembers(members: Member[]): void {
    const inVoice = new Set(members.filter((m) => m.voice).map((m) => m.id));
    for (const id of [...this.peers.keys()]) if (!inVoice.has(id)) this.drop(id);
  }

  async onSignal(from: string, data: SignalData): Promise<void> {
    if ("sdp" in data && data.sdp?.type === "offer") {
      const peer = this.peers.get(from) ?? this.create(from, false);
      await peer.pc.setRemoteDescription(data.sdp);
      // The offer created our transceiver as receive-only; send on it too, even with no mic yet.
      const transceiver = peer.pc.getTransceivers()[0];
      if (transceiver) {
        transceiver.direction = "sendrecv";
        const track = this.mic?.getAudioTracks()[0];
        if (track) await transceiver.sender.replaceTrack(track);
      }
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      this.signal(from, { sdp: { type: "answer", sdp: peer.pc.localDescription!.sdp } });
      await this.flush(peer);
    } else if ("sdp" in data && data.sdp?.type === "answer") {
      const peer = this.peers.get(from);
      if (!peer || peer.pc.signalingState !== "have-local-offer") return;
      await peer.pc.setRemoteDescription(data.sdp);
      await this.flush(peer);
    } else if ("candidate" in data && data.candidate) {
      const peer = this.peers.get(from);
      if (!peer) return;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pending.push(data.candidate);
    }
  }

  private async call(id: string, iceRestart = false): Promise<void> {
    let peer = this.peers.get(id);
    if (!peer) {
      peer = this.create(id, true);
      const track = this.mic?.getAudioTracks()[0];
      peer.pc.addTransceiver(track ?? "audio", { direction: "sendrecv" });
    }
    await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart }));
    this.signal(id, { sdp: { type: "offer", sdp: peer.pc.localDescription!.sdp } });
  }

  private create(id: string, offerer: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = new Audio();
    audio.autoplay = true;
    const peer: Peer = { pc, offerer, audio, pending: [] };
    this.peers.set(id, peer);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signal(id, { candidate: ev.candidate.toJSON() as never });
    };
    pc.ontrack = (ev) => {
      const stream = new MediaStream([ev.track]);
      // Chrome only feeds remote audio into Web Audio while a media element plays it.
      audio.srcObject = stream;
      void audio.play().catch(() => {});
      peer.meter = this.meter(stream) ?? undefined;
    };
    let restarted = false;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        restarted = false;
        this.onPeerHealth(id, true);
      } else if (pc.connectionState === "failed") {
        // The caller gets one ICE restart before we tell anyone it is broken.
        if (peer.offerer && !restarted) {
          restarted = true;
          void this.call(id, true);
        } else {
          this.onPeerHealth(id, false);
        }
      }
    };
    return peer;
  }

  private drop(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    peer.audio.srcObject = null;
    this.peers.delete(id);
    this.onPeerHealth(id, true);
  }

  private async flush(peer: Peer): Promise<void> {
    for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  private signal(to: string, data: SignalData): void {
    this.send({ type: "signal", to, data });
  }

  private applyMute(): void {
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
  }

  private meter(stream: MediaStream): Meter | null {
    if (!this.ctx) return null;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    this.ctx.createMediaStreamSource(stream).connect(analyser);
    return { analyser, buf: new Float32Array(analyser.fftSize), lastLoud: 0 };
  }

  private measure(): void {
    const now = performance.now();
    const loud = (m: Meter | null | undefined): boolean => {
      if (!m) return false;
      m.analyser.getFloatTimeDomainData(m.buf);
      let sum = 0;
      for (const v of m.buf) sum += v * v;
      if (Math.sqrt(sum / m.buf.length) > SPEAKING_LEVEL) m.lastLoud = now;
      return now - m.lastLoud < SPEAKING_HOLD_MS;
    };
    const next = new Set<string>();
    if (!this.muted && loud(this.localMeter)) next.add(this.myId);
    for (const [id, peer] of this.peers) if (loud(peer.meter)) next.add(id);
    this.setSpeaking(next);
  }

  private setSpeaking(next: Set<string>): void {
    if (next.size === this.speaking.size && [...next].every((id) => this.speaking.has(id))) return;
    this.speaking = next;
    this.onSpeaking(next);
  }
}

const DUCK_LEVEL = 0.3;

/** Lowers the movie while someone talks, without losing volume changes the viewer makes meanwhile. */
export class Ducker {
  private base: number;
  private ducked = false;
  private expected: number;

  constructor(private video: HTMLVideoElement) {
    this.base = video.volume;
    this.expected = video.volume;
    video.addEventListener("volumechange", this.onVolume);
  }

  set(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    this.expected = on ? this.base * DUCK_LEVEL : this.base;
    this.video.volume = this.expected;
  }

  destroy(): void {
    this.set(false);
    this.video.removeEventListener("volumechange", this.onVolume);
  }

  private onVolume = () => {
    if (Math.abs(this.video.volume - this.expected) < 0.001) return;
    // The viewer moved the slider: treat it as their new full volume.
    this.base = this.ducked ? Math.min(1, this.video.volume / DUCK_LEVEL) : this.video.volume;
    this.expected = this.video.volume;
  };
}
