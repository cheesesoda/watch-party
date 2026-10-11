import { expectedPosition, type ClientMessage, type PlaybackState } from "../../shared/protocol.ts";

/** Seek when we are this far from where the room is (seconds). */
const HARD_DRIFT = 1.5;
/** Nudge playback rate when drift is between this and HARD_DRIFT. */
const SOFT_DRIFT = 0.3;
/** A local seek this far from the room position counts as the user seeking. */
const USER_SEEK = 1.0;

/**
 * Keeps a <video> element in step with the room's PlaybackState.
 *
 * Remote changes are applied to the element; element events that disagree with
 * the room state are treated as the local user acting and sent to the server.
 * Comparing against the expected state (rather than flagging programmatic
 * changes) avoids echo loops without timing hacks.
 */
export class VideoSync {
  private state: PlaybackState | null = null;
  private offsets: Array<{ rtt: number; offset: number }> = [];
  private offset = 0;
  private timer: number | undefined;
  private detach: () => void;
  /** Set when the browser refused to autoplay; the UI asks for a click. */
  onAutoplayBlocked: (blocked: boolean) => void = () => {};

  constructor(
    private video: HTMLVideoElement,
    private send: (msg: ClientMessage) => void,
  ) {
    const onPlay = () => {
      this.onAutoplayBlocked(false);
      if (this.state?.paused) this.local("play");
    };
    const onPause = () => {
      if (this.state && !this.state.paused && !video.ended) this.local("pause");
    };
    const onSeeked = () => {
      if (this.state && Math.abs(video.currentTime - this.target()) > USER_SEEK) this.local("seek");
    };
    const onLoaded = () => this.reconcile();
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoaded);
    this.timer = window.setInterval(() => this.reconcile(), 1000);
    this.detach = () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onLoaded);
      window.clearInterval(this.timer);
    };
  }

  destroy(): void {
    this.detach();
  }

  serverNow(): number {
    return Date.now() + this.offset;
  }

  /** Records a ping round trip; the lowest-latency recent sample wins. */
  onPong(clientTime: number, serverTime: number): void {
    const now = Date.now();
    const rtt = now - clientTime;
    this.offsets.push({ rtt, offset: serverTime - (clientTime + rtt / 2) });
    if (this.offsets.length > 10) this.offsets.shift();
    this.offset = this.offsets.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
  }

  setState(state: PlaybackState): void {
    this.state = state;
    this.reconcile();
  }

  private target(): number {
    return this.state ? expectedPosition(this.state, this.serverNow()) : 0;
  }

  /** The local user did something: update optimistically and tell the room. */
  private local(type: "play" | "pause" | "seek"): void {
    if (!this.state) return;
    const position = this.video.currentTime;
    const paused = type === "seek" ? this.state.paused : type === "pause";
    this.state = { ...this.state, paused, position, updatedAt: this.serverNow() };
    this.send({ type, position });
  }

  private reconcile(): void {
    const { video, state } = this;
    // Skip while a seek is in flight; the position is meaningless until it lands.
    if (!state || video.readyState < HTMLMediaElement.HAVE_METADATA || video.seeking) return;
    const target = Math.min(this.target(), Number.isFinite(video.duration) ? video.duration : Infinity);
    const drift = video.currentTime - target;

    if (state.paused) {
      video.playbackRate = 1;
      if (!video.paused) video.pause();
      if (Math.abs(drift) > 0.25) video.currentTime = target;
      return;
    }

    if (Math.abs(drift) > HARD_DRIFT) {
      video.playbackRate = 1;
      video.currentTime = target;
    } else if (Math.abs(drift) > SOFT_DRIFT) {
      video.playbackRate = drift < 0 ? 1.05 : 0.95;
    } else {
      video.playbackRate = 1;
    }

    if (video.paused && !video.ended) {
      video.play().catch((err: DOMException) => {
        if (err.name === "NotAllowedError") this.onAutoplayBlocked(true);
      });
    }
  }
}
