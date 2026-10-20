/** Settings > Video quality, kept per browser: the original file, or the server's lighter copy for slow connections. */
export type Quality = "auto" | "original" | "light";

const KEY = "video-quality";

export const QUALITY_CHOICES: Array<{ value: Quality; label: string; detail: string }> = [
  { value: "auto", label: "Auto", detail: "The original file. Switches to a lighter stream if this device keeps waiting for video." },
  { value: "original", label: "Original", detail: "The full file whenever this browser can play it." },
  { value: "light", label: "Lighter (720p)", detail: "A smaller stream for slow connections. The server converts it while you watch." },
];

export function loadQuality(): Quality {
  try {
    const v = localStorage.getItem(KEY);
    return v === "original" || v === "light" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function saveQuality(q: Quality): void {
  try {
    localStorage.setItem(KEY, q);
  } catch {}
}

/** One wait this long is enough (also checked while it's still going). */
export const LONG_WAIT_MS = 10_000;
const PLAYING_MS = 2_000;
const JUMP_MS = 5_000;
const WINDOW_MS = 5 * 60_000;
const COUNT = 2;

/**
 * Notices a device that keeps waiting for video, so Auto quality can switch it to the lighter stream: a wait of 10 s,
 * or two waits within 5 minutes. Short waits don't count, and a jump's wait gets longer, since loading a new spot
 * takes a moment on any connection. The same rules as the Android app's SlowConnection.
 */
export class SlowConnection {
  private waits: number[] = [];

  /** A wait for video of `ms` ended at `now` (ms); `jump`: right after a jump. True when it's time to switch. */
  waited(ms: number, jump: boolean, now: number): boolean {
    if (ms >= LONG_WAIT_MS) return true;
    if (ms < (jump ? JUMP_MS : PLAYING_MS)) return false;
    this.waits = this.waits.filter((t) => now - t <= WINDOW_MS);
    this.waits.push(now);
    return this.waits.length >= COUNT;
  }
}
