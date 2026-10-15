import { expectedPosition, type ClientMessage, type PlaybackState } from "../../shared/protocol.ts";

/** Seek when we are this far from where the room is (seconds). */
const HARD_DRIFT = 1.5;
/** Nudge playback rate when drift is between this and HARD_DRIFT. */
const SOFT_DRIFT = 0.15;
/** Once nudging, keep at it until this close, so it doesn't settle just under SOFT_DRIFT. */
const SETTLED = 0.04;
/** A local seek this far from the room position counts as the user seeking. */
const USER_SEEK = 1.0;
/** Longest drag along the seek bar before letting go counts as pausing there. */
const SCRUB_MS = 10_000;

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
  /** The hold this page last said it was ready for, so it says so once. */
  /** Playing the server's converted copy (said in "ready", for the server's log). */
  converted = false;
  /** The last hold seen, so a screen it gave up on can say when it caught up. */
  private lastHold = "";
  private readyFor = "";
  /**
   * Dragging along the browser's own seek bar pauses the video, seeks, then plays again. Treated as one jump, so
   * the room holds for everyone instead of hearing pause and play and moving on without the slower screens.
   */
  private scrubbing: number | undefined;
  private timer: number | undefined;
  private detach: () => void;
  /** Set by [skip] until its jump goes out, so friends hear what it skipped. */
  private skipping: "intro" | "recap" | undefined;
  /** Set when the browser refused to autoplay; the UI asks for a click. */
  onAutoplayBlocked: (blocked: boolean) => void = () => {};

  constructor(
    private video: HTMLVideoElement,
    private send: (msg: ClientMessage) => void,
  ) {
    const onPlay = () => {
      this.onAutoplayBlocked(false);
      if (this.scrubbing !== undefined) return this.scrubbed();
      if (this.state?.paused) this.local("play");
    };
    const onPause = () => {
      if (!this.state || this.state.paused || video.ended) return;
      // A click on the seek bar pauses and plays again at once; the seek that follows is the jump.
      if (!video.paused) return;
      if (video.seeking) {
        window.clearTimeout(this.scrubbing);
        this.scrubbing = window.setTimeout(() => this.scrubbed(true), SCRUB_MS);
        return;
      }
      this.local("pause");
    };
    const onSeeked = () => {
      if (this.scrubbing !== undefined) return;
      if (this.state && Math.abs(video.currentTime - this.target()) > USER_SEEK) this.local("seek");
      this.reconcile();
    };
    const onLoaded = () => this.reconcile();
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("canplay", onLoaded);
    this.timer = window.setInterval(() => this.reconcile(), 1000);
    this.detach = () => {
      window.clearTimeout(this.scrubbing);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("canplay", onLoaded);
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

  /** Skip intro / Skip recap: a jump to [position] that says what it skipped. */
  skip(position: number, kind: "intro" | "recap"): void {
    this.skipping = kind;
    this.video.currentTime = position;
  }

  /** Where the room's playback is right now. */
  expected(): number {
    return this.target();
  }

  private target(): number {
    return this.state ? expectedPosition(this.state, this.serverNow()) : 0;
  }

  /** Let go of the seek bar: one jump. [stayedPaused]: the browser didn't play again, so it was a pause too. */
  private scrubbed(stayedPaused = false): void {
    window.clearTimeout(this.scrubbing);
    this.scrubbing = undefined;
    if (stayedPaused && this.video.paused) this.local("pause");
    if (this.state && Math.abs(this.video.currentTime - this.target()) > USER_SEEK) this.local("seek");
    this.reconcile();
  }

  /** The local user did something: update optimistically and tell the room. */
  private local(type: "play" | "pause" | "seek"): void {
    if (!this.state) return;
    const position = this.video.currentTime;
    const paused = type === "seek" ? this.state.paused : type === "pause";
    // A jump while playing holds everyone at the new spot until each screen has loaded it (the server decides when).
    const hold = type === "seek" && (this.state.hold || !this.state.paused);
    this.state = { ...this.state, paused: paused || hold, position, updatedAt: this.serverNow(), hold: hold || undefined };
    const skip = type === "seek" ? this.skipping : undefined;
    this.skipping = undefined;
    // Our estimate of the server's clock right now, once a ping has measured it.
    const at = this.offsets.length > 0 ? Math.round(this.serverNow()) : undefined;
    this.send(type === "seek" ? { type, position, at, skip } : { type, position, at });
  }

  private reconcile(): void {
    const { video, state } = this;
    // Skip while a seek is in flight; the position is meaningless until it lands.
    if (!state || this.scrubbing !== undefined || video.readyState < HTMLMediaElement.HAVE_METADATA || video.seeking) return;
    const target = Math.min(this.target(), Number.isFinite(video.duration) ? video.duration : Infinity);
    const drift = video.currentTime - target;

    if (state.hold) this.lastHold = `${state.updatedAt}:${state.position}`;
    if (state.paused) {
      video.playbackRate = 1;
      if (!video.paused) video.pause();
      if (Math.abs(drift) > 0.25) video.currentTime = target;
      else if (state.hold && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        const key = `${state.updatedAt}:${state.position}`;
        if (this.readyFor !== key) {
          this.readyFor = key;
          this.send({ type: "ready", position: video.currentTime, converted: this.converted || undefined });
        }
      }
      return;
    }

    // The hold gave up on this screen before it loaded: now it plays in step, say so once (for the server's log).
    if (this.lastHold && this.readyFor !== this.lastHold && !video.paused && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && Math.abs(drift) <= HARD_DRIFT) {
      this.readyFor = this.lastHold;
      this.send({ type: "ready", position: video.currentTime, late: true, converted: this.converted || undefined });
    }
    if (Math.abs(drift) > HARD_DRIFT) {
      video.playbackRate = 1;
      video.currentTime = target;
    } else if (Math.abs(drift) > (video.playbackRate !== 1 ? SETTLED : SOFT_DRIFT)) {
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
