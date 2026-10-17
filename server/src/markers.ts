import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { MediaItem, SkipMarks, TimeRange } from "../../shared/protocol.ts";

/** Seconds of sound per chromaprint point: 4096-sample frames at 11025 Hz, each a third of a frame after the last. */
export const POINT_SECONDS = 4096 / 3 / 11025;
/** Points this close (differing in at most this many of their 32 bits) count as the same sound. */
const MAX_BIT_DIFF = 6;
/** A gap this long inside a matching stretch (a line of dialogue over the theme, say) doesn't end it. */
const MAX_GAP_SECONDS = 3.5;
/** Intros are looked for in the first quarter of an episode, at most this far in, and are this long. */
const INTRO_WINDOW = 600;
const INTRO_MIN = 15;
const INTRO_MAX = 150;
/** Credits are looked for in the last fifth of an episode, at most this far from the end. */
const CREDITS_WINDOW = 480;
const CREDITS_MIN = 15;
/** Bump when finding gets better, so files looked at before are looked at again. */
const VERSION = 3;
/** Skip chapters shorter than this get no button: gone before anyone could press it. */
const SKIP_MIN = 10;
/** A keyframe counts as credits when this much of it (%) is black: white text on black. */
const CREDITS_BLACK = 85;

/** A stretch two fingerprints share: where it is in each, in seconds from the start of each fingerprint. */
export interface Shared {
  a: TimeRange;
  b: TimeRange;
}

function bits(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * The longest stretch of sound two fingerprints share (an intro two episodes both have, say), at least [min] seconds
 * long, or null. Points that match exactly suggest how far apart the two are; each of the likeliest offsets is then
 * checked point by point, allowing small differences between the two encodes.
 */
export function sharedStretch(a: Uint32Array, b: Uint32Array, min: number, max = Infinity): Shared | null {
  const where = new Map<number, number[]>();
  b.forEach((v, j) => {
    const list = where.get(v);
    if (list) list.push(j);
    else where.set(v, [j]);
  });
  const votes = new Map<number, number>();
  a.forEach((v, i) => {
    for (const j of where.get(v) ?? []) votes.set(i - j, (votes.get(i - j) ?? 0) + 1);
  });
  const offsets = [...votes.entries()].filter(([, n]) => n >= 3).sort((x, y) => y[1] - x[1]).slice(0, 25).map(([o]) => o);
  const gap = Math.round(MAX_GAP_SECONDS / POINT_SECONDS);
  let best: { start: number; end: number; offset: number } | null = null;
  for (const offset of offsets) {
    let start = -1;
    let last = -1;
    const close = () => {
      if (start >= 0 && (!best || last - start > best.end - best.start)) best = { start, end: last, offset };
    };
    for (let i = Math.max(0, offset); i < Math.min(a.length, b.length + offset); i++) {
      if (bits(a[i] ^ b[i - offset]) > MAX_BIT_DIFF) continue;
      if (start < 0 || i - last > gap) {
        close();
        start = i;
      }
      last = i;
    }
    close();
  }
  if (!best) return null;
  const { start, end, offset } = best as { start: number; end: number; offset: number };
  const length = (end - start + 1) * POINT_SECONDS;
  if (length < min || length > max) return null;
  const range = (from: number): TimeRange => ({ start: round(from * POINT_SECONDS), end: round((from + end - start + 1) * POINT_SECONDS) });
  return { a: range(start), b: range(start - offset) };
}

const round = (s: number) => Math.round(s * 10) / 10;
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/**
 * The second credits search: this much of a known outro is looked for, and this much of it has to match, starting
 * within OUTRO_START of the outro's start. A later part matching alone (the logos at the very end, STING_MIN of it is
 * enough) means the credits play over something else, so they're found by walking back from it through the picture.
 */
const OUTRO_CLIP = 60;
const CREDITS_RETRY_MIN = 10;
const OUTRO_START = 5;
const STING_MIN = 8;
/** Credit cards over a dark picture before the end logos: this % black is enough when the logos anchor them. */
const STING_DARK = 50;
/** Bumped when finding credits changes, so episodes without them (or given them by an older second search) are looked at again. */
const CREDITS_RETRY = 3;
/** Between keyframes over still credit cards: this long a gap between two dark ones doesn't end the stretch. */
const KEYFRAME_GAP = 40;
/** Two frames a second: a picture card among the credits can take this many in a row. */
const CLOSE_ODD = 8;
/** Every half second, a card full of names can read a bit under [CREDITS_BLACK] for seconds at a time (Reacher S1E03). */
const CLOSE_BLACK = 80;
/**
 * Credits found by sound start where the outro music does, which can be well into the credit cards (Archer S1E03: the
 * cards start 28 s earlier). The picture this far before is checked for where the cards begin.
 */
const WALK_BACK = 60;
/**
 * How dark a pixel has to be to count as black when looking for where cards start: card backgrounds are true black,
 * while night scenes (Lucifer) are mostly a little lighter and would pass for cards at the usual 32.
 */
const CARD_BLACK = 18;
/** Bumped when the walk back changes, so every sound mark is walked back again from where sound put it. */
const WALKED = 2;
/**
 * A credits chapter can start a little before its cards (Reacher S2E06's starts 10 s early, in a dark scene): up to
 * this far in, the first of at least CHAPTER_EARLY_CARDS seconds of true-black cards is where they start. It's
 * only ever moved later.
 */
const CHAPTER_EARLY = 30;
const CHAPTER_EARLY_CARDS = 5;
/** Bumped when that check changes, so every credits chapter is checked again. */
const CHAPTER_CHECK = 1;
/** A season's first episode checked against the season before it for a recap ("Previously on" opening a new season). */
const OPENER_RECAP = 2;

/**
 * Where [clip] plays inside [within], trying every offset (unlike sharedStretch, which starts from points that match
 * exactly): the longest stretch of at least [min] seconds where at least half the points match, in seconds into
 * [within], with [from], how far into [clip] the stretch starts, or null.
 */
export function findClip(within: Uint32Array, clip: Uint32Array, min: number): (TimeRange & { from: number }) | null {
  const gap = Math.round(MAX_GAP_SECONDS / POINT_SECONDS);
  let best: { start: number; end: number; offset: number } | null = null;
  for (let offset = -clip.length + 1; offset < within.length; offset++) {
    let start = -1;
    let last = -1;
    let hits = 0;
    const close = () => {
      if (start >= 0 && hits * 2 >= last - start + 1 && (!best || last - start > best.end - best.start)) best = { start, end: last, offset };
    };
    for (let k = Math.max(0, -offset); k < clip.length && offset + k < within.length; k++) {
      const i = offset + k;
      if (bits(within[i] ^ clip[k]) > MAX_BIT_DIFF) continue;
      if (start < 0 || i - last > gap) {
        close();
        start = i;
        hits = 0;
      }
      last = i;
      hits++;
    }
    close();
  }
  if (!best) return null;
  const { start, end, offset } = best as { start: number; end: number; offset: number };
  if ((end - start + 1) * POINT_SECONDS < min) return null;
  return { start: round(start * POINT_SECONDS), end: round((end + 1) * POINT_SECONDS), from: round((start - offset) * POINT_SECONDS) };
}

/**
 * Every stretch of at least [min] seconds two fingerprints share, at any of their likeliest offsets: the clips a
 * recap took from an earlier episode, say.
 */
export function sharedStretches(a: Uint32Array, b: Uint32Array, min: number): Shared[] {
  const where = new Map<number, number[]>();
  b.forEach((v, j) => {
    const list = where.get(v);
    if (list) list.push(j);
    else where.set(v, [j]);
  });
  const votes = new Map<number, number>();
  a.forEach((v, i) => {
    for (const j of where.get(v) ?? []) votes.set(i - j, (votes.get(i - j) ?? 0) + 1);
  });
  const offsets = [...votes.entries()].filter(([, n]) => n >= 3).sort((x, y) => y[1] - x[1]).slice(0, 60).map(([o]) => o);
  const gap = Math.round(MAX_GAP_SECONDS / POINT_SECONDS);
  const found: Shared[] = [];
  for (const offset of offsets) {
    let start = -1;
    let last = -1;
    let hits = 0;
    const close = () => {
      if (start >= 0 && (last - start + 1) * POINT_SECONDS >= min && hits * 2 >= last - start + 1) {
        found.push({
          a: { start: round(start * POINT_SECONDS), end: round((last + 1) * POINT_SECONDS) },
          b: { start: round((start - offset) * POINT_SECONDS), end: round((last + 1 - offset) * POINT_SECONDS) },
        });
      }
    };
    for (let i = Math.max(0, offset); i < Math.min(a.length, b.length + offset); i++) {
      if (bits(a[i] ^ b[i - offset]) > MAX_BIT_DIFF) continue;
      if (start < 0 || i - last > gap) {
        close();
        start = i;
        hits = 0;
      }
      last = i;
      hits++;
    }
    close();
  }
  return found;
}

/** Earlier sound a recap may have reused: a fingerprint, where it starts in its episode, and parts to ignore there. */
export interface RecapSource {
  points: Uint32Array;
  /** Seconds into its episode where [points] start. */
  from: number;
  /** Seconds into its episode that don't count: its logos, intro and credits, which every episode shares. */
  ignore: (t: number) => boolean;
}

/** A recap's clips are at least this long, start this early, and sit no further apart than this (narration between). */
const RECAP_CLIP = 2.5;
const RECAP_STARTS_BY = 240;
const RECAP_GAP = 20;

const overlaps = (a: TimeRange, b: TimeRange) => a.end > b.start && a.start < b.end;

/**
 * The parts of [head] that at least two of [others] also have: studio logos, the theme, anything every episode opens
 * with, as opposed to a scene from one earlier episode.
 */
export function recurring(head: Uint32Array, others: Uint32Array[]): TimeRange[] {
  const count = new Uint16Array(head.length);
  for (const other of others) {
    const seen = new Uint8Array(head.length);
    for (const hit of sharedStretches(head, other, RECAP_CLIP)) {
      const from = Math.round(hit.a.start / POINT_SECONDS);
      const to = Math.min(head.length, Math.round(hit.a.end / POINT_SECONDS));
      for (let i = from; i < to; i++) seen[i] = 1;
    }
    seen.forEach((v, i) => (count[i] += v));
  }
  const out: TimeRange[] = [];
  let start = -1;
  for (let i = 0; i <= head.length; i++) {
    const on = i < head.length && count[i] >= 2;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      out.push({ start: round(start * POINT_SECONDS), end: round(i * POINT_SECONDS) });
      start = -1;
    }
  }
  return out;
}

/** Silence and steady hum repeat one point over and over and match anything else quiet; a clip needs some variety. */
function varied(points: Uint32Array, range: TimeRange): boolean {
  const from = Math.round(range.start / POINT_SECONDS);
  const to = Math.min(points.length, Math.round(range.end / POINT_SECONDS));
  return new Set(points.subarray(from, to)).size * 2 >= to - from;
}

/**
 * Where an episode's recap is: the run of clips at its start that also play in earlier episodes, from the first clip
 * to the last, however long that is. [head] is the episode's opening; [skip] are parts of it that don't count (its
 * intro, and sound every episode shares). Null when there's no such run, or it is too short to bother skipping.
 */
export function findRecap(head: Uint32Array, skip: TimeRange[], sources: RecapSource[]): TimeRange | null {
  const clips: TimeRange[] = [];
  for (const source of sources) {
    for (const hit of sharedStretches(head, source.points, RECAP_CLIP)) {
      if (source.ignore(source.from + (hit.b.start + hit.b.end) / 2)) continue;
      if (skip.some((r) => overlaps(hit.a, r))) continue;
      if (!varied(head, hit.a)) continue;
      clips.push(hit.a);
    }
  }
  clips.sort((x, y) => x.start - y.start);
  let run: TimeRange | null = null;
  for (const c of clips) {
    if (!run) {
      if (c.start > RECAP_STARTS_BY) break;
      run = { ...c };
    } else if (c.start <= run.end + RECAP_GAP) run.end = Math.max(run.end, c.end);
    else break;
  }
  return run && run.end - run.start >= SKIP_MIN ? run : null;
}

const RECAP = /\b(recap|previously)\b/;
const INTRO = /^(intro|introduction|opening|opening credits|opening titles|op|title sequence|main titles?|theme song)$/;
const CREDITS = /^(credits|end credits|closing credits|ending|ending credits|ed|outro|end titles)$/;

/**
 * Chapter names that mark an intro, a recap or the credits ("Chapter 3" and the like mark nothing). Back-to-back
 * chapters of a kind join up ("Title Sequence" then "Opening Credits" is one intro); an intro or recap shorter than
 * SKIP_MIN is left out.
 */
export function chapterMarks(chapters: { start: number; end: number; title: string }[]): SkipMarks {
  const marks: SkipMarks = {};
  let prev: "intro" | "recap" | null = null;
  for (const c of chapters) {
    const t = c.title.trim().toLowerCase();
    const kind = RECAP.test(t) ? "recap" : INTRO.test(t) ? "intro" : null;
    if (kind) {
      const range = marks[kind];
      if (!range) marks[kind] = { start: round(c.start), end: round(c.end) };
      else if (prev === kind && Math.abs(c.start - range.end) <= 1) range.end = round(c.end);
    } else if (marks.credits == null && CREDITS.test(t)) marks.credits = round(c.start);
    prev = kind;
  }
  for (const kind of ["intro", "recap"] as const) {
    const range = marks[kind];
    if (range && range.end - range.start < SKIP_MIN) delete marks[kind];
  }
  return marks;
}

/** A chapter starting this close to where sound says an intro starts, and this much of it heard, is that intro. */
const CHAPTER_NEAR = 10;
const CHAPTER_HEARD = 0.4;

/**
 * The intro sound found, run on to the end of the (unnamed) chapter it opens, when there is one: an episode whose edit
 * of the titles only one other shares in part (Game of Thrones S1E09 and E10, 63 s of their 1:48) still gets all of
 * them (and an intro already run on is the same again, so it isn't thrown out as sound few episodes share). Null when
 * no chapter fits: none starting within CHAPTER_NEAR of it, ending where or after it does, no longer than an intro can
 * be, and at least CHAPTER_HEARD of it heard.
 */
export function introChapter(intro: TimeRange, chapters: { start: number; end: number; title: string }[]): TimeRange | null {
  let end: number | null = null;
  for (const c of chapters) {
    const heard = Math.min(intro.end, c.end) - Math.max(intro.start, c.start);
    if (Math.abs(c.start - intro.start) > CHAPTER_NEAR || c.end < intro.end || c.end - c.start > INTRO_MAX) continue;
    if (heard < (c.end - c.start) * CHAPTER_HEARD) continue;
    end = Math.max(end ?? 0, c.end);
  }
  return end != null ? { start: intro.start, end: round(end) } : null;
}

/** What version 1 took from chapter names (the first matching chapter of each kind), to tell it from what sound found. */
function oldChapterMarks(chapters: { start: number; end: number; title: string }[]): SkipMarks {
  const marks: SkipMarks = {};
  for (const c of chapters) {
    const t = c.title.trim().toLowerCase();
    const range = { start: round(c.start), end: round(c.end) };
    if (!marks.recap && RECAP.test(t)) marks.recap = range;
    else if (!marks.intro && INTRO.test(t)) marks.intro = range;
    else if (marks.credits == null && CREDITS.test(t)) marks.credits = round(c.start);
  }
  return marks;
}

/**
 * Where the credits start, going by the picture: the last stretch of frames that are nearly all black (white text on
 * black), at least 20 s long and ending within 30 s of the end (a bright studio logo may follow, black or not after
 * it). Up to [odd] other frames in a row inside are fine (a picture card), more end the stretch, and so does a gap
 * longer than [gap] seconds between dark frames. A frame is dark at [min] % black or more. [frames] are seconds from the start of the window and % black, in any order (ffmpeg doesn't always
 * print keyframes in order); [length] is the window's length.
 */
export function blackCredits(unsorted: { t: number; black: number }[], length: number, gap = 12, odd = 1, min = CREDITS_BLACK): number | null {
  const frames = [...unsorted].sort((a, b) => a.t - b.t);
  const dark = (i: number) => frames[i].black >= min;
  for (let i = frames.length - 1; i >= 0 && length - frames[i].t <= 30; i--) {
    if (!dark(i)) continue;
    let start = i;
    let bright = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (frames[start].t - frames[j].t > gap) break;
      if (dark(j)) {
        start = j;
        bright = 0;
      } else if (++bright > odd) break;
    }
    if (frames[i].t - frames[start].t >= 20) return frames[start].t;
  }
  return null;
}

/**
 * Where credits that end at known logos start, going by the picture: walking back from the logos ([end], seconds into
 * the window) through keyframes that are mostly dark (credit cards over a dim scene), one odd keyframe allowed, two
 * in a row or a gap over 12 s ending it. The stretch has to reach the logos and last at least 10 s.
 */
export function creditsBefore(unsorted: { t: number; black: number }[], end: number): number | null {
  const frames = [...unsorted].sort((a, b) => a.t - b.t);
  const dark = (i: number) => frames[i].black >= STING_DARK;
  let i = frames.length - 1;
  while (i >= 0 && frames[i].t > end) i--;
  while (i >= 0 && !dark(i) && end - frames[i].t <= 8) i--;
  if (i < 0 || !dark(i) || end - frames[i].t > 8) return null;
  let start = i;
  let bright = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (frames[start].t - frames[j].t > 12) break;
    if (dark(j)) {
      start = j;
      bright = 0;
    } else if (++bright >= 2) break;
  }
  return end - frames[start].t >= 10 ? frames[start].t : null;
}

/**
 * Where the cards start, when a credits chapter starts before them: [unsorted] frames (two a second, true black) from
 * where the chapter starts. Null when it starts on cards already, or no run of them starts within CHAPTER_EARLY.
 */
export function cardsAfter(unsorted: { t: number; black: number }[]): number | null {
  const frames = [...unsorted].sort((a, b) => a.t - b.t);
  const run = (from: number, length: number) => frames.filter((f) => f.t >= from && f.t < from + length);
  const cards = (list: { black: number }[]) => list.length > 0 && list.filter((f) => f.black >= CREDITS_BLACK).length >= list.length * 0.8;
  if (cards(run(0, 2))) return null;
  for (const f of frames) {
    if (f.t > CHAPTER_EARLY) break;
    if (f.black < CREDITS_BLACK) continue;
    const next = run(f.t, CHAPTER_EARLY_CARDS);
    if (next.length >= CHAPTER_EARLY_CARDS * 2 - 1 && cards(next)) return f.t;
  }
  return null;
}

/** A stretch of an episode's ending it shares with another episode: where it starts in this one, and how long it is. */
export interface Outro {
  start: number;
  length: number;
}

/** Shorter than this, a shared ending is only trusted when no other episode shares a longer one. */
const OUTRO_TRUSTED = 20;

/** Where an episode's credits start by sound: the earliest of the outros it shares, leaving out short ones when longer ones agree. */
export function outroStart(outros: Outro[]): number | null {
  const long = outros.filter((o) => o.length >= OUTRO_TRUSTED);
  const from = long.length ? long : outros;
  return from.length ? Math.min(...from.map((o) => o.start)) : null;
}

/**
 * Where credit cards that are already showing at [mark] (seconds into the window, frames two a second) started: walking
 * back through mostly dark frames, two odd ones in a row allowed, to the first frame after a bright picture. Null when
 * [mark] isn't on cards, when they start within 2 s of it anyway, or when nothing bright before them says where they
 * start (a gap in the frames, or dark all the way back to the window's start).
 */
export function cardsBefore(unsorted: { t: number; black: number }[], mark: number): number | null {
  const frames = [...unsorted].sort((a, b) => a.t - b.t);
  const dark = (i: number) => frames[i].black >= STING_DARK;
  let i = frames.length - 1;
  while (i >= 0 && frames[i].t > mark) i--;
  if (i < 0 || !dark(i) || mark - frames[i].t > 2) return null;
  let start = i;
  let bright = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (frames[j + 1].t - frames[j].t > 3) return null;
    if (dark(j)) {
      start = j;
      bright = 0;
    } else if (++bright > 2) return mark - frames[start].t >= 2 ? frames[start].t : null;
  }
  return null;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: Buffer }> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolve({ code: null, out: Buffer.alloc(0) });
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.stdout!.on("data", (d: Buffer) => chunks.push(d));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out: Buffer.alloc(0) });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(chunks) });
    });
  });
}

export interface MarkersConfig {
  ffmpeg: string;
  ffprobe: string;
  /** Where what was found is kept (data/markers.json); "" keeps it in memory only. */
  file: string;
  /** Skip times set by hand (data/skip-times.json); "" or left out keeps them in memory only. */
  handFile?: string;
}

/**
 * Skip times set by hand for one video, put over what was found kind by kind: a kind left out is still found, null
 * means none. Kept apart from what was found, so looking again never replaces them.
 */
export interface HandSet extends SkipMarks {
  /** The video's path in its library folder, so the file can be read and edited by hand. */
  file?: string;
}

/** [raw] as skip times set by hand, or null when it isn't any: ranges need 0 <= start < end, credits a time >= 0. */
export function handSet(raw: unknown): HandSet | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: HandSet = {};
  const time = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  for (const kind of ["intro", "recap"] as const) {
    if (!(kind in r)) continue;
    const v = r[kind] as { start?: unknown; end?: unknown } | null;
    if (v === null) out[kind] = null;
    else if (v && time(v.start) && time(v.end) && (v.end as number) > (v.start as number)) out[kind] = { start: round(v.start as number), end: round(v.end as number) };
    else return null;
  }
  if ("credits" in r) {
    if (r.credits === null) out.credits = null;
    else if (time(r.credits)) out.credits = round(r.credits as number);
    else return null;
  }
  if (typeof r.file === "string") out.file = r.file;
  return out;
}

interface Entry {
  /** The file's size and when it landed, so a replaced file is looked at again. */
  key: string;
  v: number;
  marks: SkipMarks;
  /** How many episodes its season had when nothing was found by sound, so adding more tries again. */
  peers?: number;
  /** What sound alone found (version 2 on), so chapter rules can change without listening again. */
  sound?: SkipMarks;
  /** Whether the episode's opening has been checked against earlier episodes for a recap (OPENER_RECAP: and the season before). */
  recapLooked?: boolean | number;
  /**
   * Which second credits search an episode without them has had (true: the first, which also took the end logos
   * alone for the start of the credits).
   */
  creditsRetried?: boolean | number;
  /** Whether a credits chapter has been checked for cards that start after it (CHAPTER_CHECK). */
  chaptersChecked?: number;
  /** Whether credits found by sound have been checked against the picture for cards that start before them. */
  walked?: boolean | number;
}

export interface MarkersEntry {
  absPath: string;
  item: MediaItem;
}

/**
 * Finds where episodes' intros and credits are, the way Plex and Jellyfin's Intro Skipper do: the episodes of a season
 * share their theme, so a stretch of sound that two episodes both have near the start is the intro, and near the end
 * the credits. ffmpeg's chromaprint (the fingerprint AcoustID uses) turns the sound into comparable points. Chapter
 * names, when a file has them, win. Recaps are found the same way, against earlier episodes: the clips at the start of
an episode that played before. Runs in the background, one file at a time,
 * and keeps what it found in data/markers.json.
 */
export class Markers {
  private cache: Record<string, Entry> = {};
  /** Skip times set by hand, by video id, and when their file last changed (it's read again when it does). */
  private hand: Record<string, HandSet> = {};
  private handChanged = 0;
  private handTimer: ReturnType<typeof setInterval> | null = null;
  private loaded: Promise<void>;
  private running: Promise<void> = Promise.resolve();
  private latest: MarkersEntry[] | null = null;
  private busy = false;
  private closed = false;
  /** Seasons whose missing credits have been listed in the log since the server started. */
  private listed = new Set<string>();

  constructor(
    private config: MarkersConfig,
    private log: (line: string) => void = (line) => console.log(`skip: ${line}`),
  ) {
    this.loaded = Promise.all([this.load(), this.loadHand()]).then(() => {});
    // Edits to the file by hand count without a restart.
    if (config.handFile) {
      this.handTimer = setInterval(() => void this.loadHand(), 5000);
      this.handTimer.unref?.();
    }
  }

  private static key(item: MediaItem): string {
    return `${item.size}:${item.addedAt ?? 0}`;
  }

  /** What's known about this file's intro, recap and credits; undefined until it has been looked at, or if none. */
  get(item: MediaItem): SkipMarks | undefined {
    const found = this.found(item);
    const hand = this.hand[item.id];
    const marks: SkipMarks = { ...found };
    for (const kind of ["intro", "recap", "credits"] as const) if (hand && kind in hand) (marks as Record<string, unknown>)[kind] = hand[kind];
    const { intro, recap, credits } = marks;
    return intro || recap || credits != null ? marks : undefined;
  }

  /** What was found for the video, leaving out what was set by hand. */
  found(item: MediaItem): SkipMarks | undefined {
    const entry = this.cache[item.id];
    if (!entry || entry.key !== Markers.key(item)) return undefined;
    return entry.marks;
  }

  /** What was set by hand for the video, if anything. */
  handSet(item: MediaItem): HandSet | null {
    return this.hand[item.id] ?? null;
  }

  /** Sets the video's skip times by hand ([marks], a kind left out still found), or with null goes back to what was found. */
  async setHand(item: MediaItem, marks: SkipMarks | null): Promise<void> {
    await this.loaded;
    await this.loadHand();
    if (marks) this.hand[item.id] = { file: item.relPath, ...marks };
    else delete this.hand[item.id];
    await this.saveHand();
  }

  /** The item with its marks, when there are any. */
  attach(item: MediaItem): MediaItem {
    const marks = this.get(item);
    return marks ? { ...item, marks } : item;
  }

  /** Looks at every file not looked at yet, in the background. A call while one runs makes it go again after. */
  warm(entries: MarkersEntry[]): Promise<void> {
    this.latest = entries;
    if (this.busy) return this.running;
    this.busy = true;
    this.running = (async () => {
      await this.loaded;
      while (this.latest && !this.closed) {
        const next = this.latest;
        this.latest = null;
        await this.pass(next).catch((err) => this.log(`stopped: ${err instanceof Error ? err.message : err}`));
      }
      this.busy = false;
    })();
    return this.running;
  }

  /** Resolves when nothing is being looked at (for tests). */
  async idle(): Promise<void> {
    while (this.busy) await this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.handTimer) clearInterval(this.handTimer);
    await this.idle().catch(() => {});
  }

  /** Whether intros and credits have been looked for since the file (or its season) last changed. */
  private heard(item: MediaItem, peers: number): boolean {
    const entry = this.cache[item.id];
    if (!entry || entry.key !== Markers.key(item) || entry.v !== VERSION) return false;
    const { intro, credits } = entry.marks;
    return (intro != null && credits != null) || (entry.peers ?? 0) >= peers;
  }

  /** Whether there's nothing left to look for: intros and credits heard, and (for episodes) the recap looked for. */
  private fresh(item: MediaItem, peers: number): boolean {
    if (!this.heard(item, peers)) return false;
    const entry = this.cache[item.id];
    return !item.episode || (!!entry.recapLooked && (entry.creditsRetried === CREDITS_RETRY || (entry.marks.credits != null && !Markers.retried(entry))));
  }

  /** Credits the first second search may have given (it took the end logos alone for their start). */
  private static retried(entry: Entry): boolean {
    return entry.creditsRetried === true && entry.sound?.credits == null;
  }

  private async pass(entries: MarkersEntry[]): Promise<void> {
    const seasons = new Map<string, MarkersEntry[]>();
    const singles: MarkersEntry[] = [];
    for (const e of entries) {
      if (e.item.extra) continue;
      const ep = e.item.episode;
      if (!ep) {
        singles.push(e);
        continue;
      }
      const key = `${ep.show.toLowerCase()}|${ep.season}`;
      if (!seasons.has(key)) seasons.set(key, []);
      seasons.get(key)!.push(e);
    }
    // Version 1 entries for files that haven't changed: brought up to date cheaply, without listening again.
    const old = entries.filter((e) => !e.item.extra && this.cache[e.item.id]?.v === 1 && this.cache[e.item.id].key === Markers.key(e.item));
    if (old.length) this.log(`updating ${old.length} earlier results (chapters joined, credits by picture)`);
    for (const [n, e] of old.entries()) {
      if (this.closed) return;
      await this.upgrade(e);
      if ((n + 1) % 25 === 0 && n + 1 < old.length) {
        // Saved as it goes, so a restart (an update) picks up here instead of starting over.
        await this.save();
        this.log(`updated ${n + 1} of ${old.length} earlier results`);
      }
    }
    if (old.length) {
      this.log(`updated ${old.length} earlier results (chapters joined, credits by picture)`);
      await this.save();
    }
    // Credits found by sound before the picture was checked for cards starting earlier: checked once now.
    const unwalked = entries.filter((e) => {
      const entry = this.cache[e.item.id];
      return e.item.episode && !e.item.extra && entry?.v === VERSION && entry.key === Markers.key(e.item) && entry.walked !== WALKED && entry.sound?.credits != null && (entry.marks.credits === entry.sound.credits || (entry.walked === true && entry.marks.credits != null && entry.marks.credits < entry.sound.credits));
    });
    // Credits chapters from before they were checked for starting early: checked once now.
    const unchecked = entries.filter((e) => {
      const entry = this.cache[e.item.id];
      return e.item.episode && !e.item.extra && entry?.v === VERSION && entry.key === Markers.key(e.item) && entry.chaptersChecked !== CHAPTER_CHECK && entry.marks.credits != null;
    });
    let early = 0;
    for (const [n, e] of unchecked.entries()) {
      if (this.closed) return;
      const entry = this.cache[e.item.id];
      const probe = await this.probe(e.absPath);
      if (!probe) continue;
      const chapter = chapterMarks(probe.chapters).credits;
      const at = chapter != null && Math.abs(chapter - entry.marks.credits!) < 0.5 ? await this.chapterCards(e.absPath, chapter) : entry.marks.credits!;
      if (at !== entry.marks.credits) early++;
      this.cache[e.item.id] = { ...entry, marks: { ...entry.marks, credits: at }, chaptersChecked: CHAPTER_CHECK };
      if ((n + 1) % 25 === 0 && n + 1 < unchecked.length) await this.save();
    }
    if (unchecked.length) {
      this.log(`checked credits chapters in ${unchecked.length} episodes (${early} start before their cards)`);
      await this.save();
    }
    if (unwalked.length) this.log(`checking where the credits start in ${unwalked.length} episodes`);
    let moved = 0;
    for (const [n, e] of unwalked.entries()) {
      if (this.closed) return;
      if (await this.walk(e)) moved++;
      if ((n + 1) % 25 === 0 && n + 1 < unwalked.length) await this.save();
    }
    if (unwalked.length) {
      this.log(`checked where the credits start in ${unwalked.length} episodes (${moved} changed)`);
      await this.save();
    }
    for (const list of seasons.values()) list.sort((x, y) => x.item.episode!.episode - y.item.episode!.episode);
    for (const list of seasons.values()) {
      if (this.closed) return;
      const ep = list[0].item.episode!;
      // A season's first episode may recap the season before: looked at once more when that season is here.
      const before = ep.season > 1 && ep.episode === 1 ? seasons.get(`${ep.show.toLowerCase()}|${ep.season - 1}`) : undefined;
      const opener = before && this.cache[list[0].item.id]?.recapLooked !== OPENER_RECAP ? before : undefined;
      if (!opener && list.every((e) => this.fresh(e.item, list.length))) {
        // Looked at before: no listening, but name the episodes still without credits once per start.
        const missing = this.missingCredits(list);
        const key = `${list[0].item.episode!.show}|${list[0].item.episode!.season}`;
        if (missing && !this.listed.has(key)) this.log(`${Markers.seasonName(list)}: credits in ${list.length - missing.count} of ${list.length} ${missing.text}`);
        this.listed.add(key);
        continue;
      }
      await this.season(list, opener);
      await this.save();
    }
    // Movies only have chapter names to go on.
    let changed = false;
    for (const e of singles) {
      if (this.closed) return;
      if (this.fresh(e.item, 1)) continue;
      const probe = await this.probe(e.absPath);
      this.set(e.item, { marks: probe ? chapterMarks(probe.chapters) : {}, peers: 1 });
      changed = true;
    }
    if (changed) await this.save();
  }

  /** [previous]: the season before, when this season's first episode is still to be checked against it for a recap. */
  private async season(list: MarkersEntry[], previous?: MarkersEntry[]): Promise<void> {
    const started = Date.now();
    const ep = list[0].item.episode!;
    const name = Markers.seasonName(list);
    const fresh = (i: number) => this.fresh(list[i].item, list.length) && !(i === 0 && previous);
    const listen = list.filter((e) => !this.heard(e.item, list.length)).length;
    const recapsDue = !!previous || list.some((e) => !this.cache[e.item.id]?.recapLooked);
    const retries = list.filter((e) => !this.fresh(e.item, list.length)).length;
    this.log(`${name}: ${listen ? `listening for intros and credits in ${listen} of ${list.length} episodes` : recapsDue ? "checking for recaps" : `looking again for credits in ${retries} of ${list.length} episodes`}`);
    const probes = await Promise.all(list.map((e) => this.probe(e.absPath)));
    const heads = new Map<number, Uint32Array | null>();
    const tails = new Map<number, Uint32Array | null>();
    const headOf = async (i: number) => {
      if (!heads.has(i)) {
        const d = probes[i]?.duration ?? 0;
        heads.set(i, d > 0 ? await this.fingerprint(list[i].absPath, 0, Math.min(INTRO_WINDOW, d / 4)) : null);
      }
      return heads.get(i)!;
    };
    const tailStart = (i: number) => {
      const d = probes[i]?.duration ?? 0;
      return Math.max(0, d - Math.min(CREDITS_WINDOW, d / 5));
    };
    const tailOf = async (i: number) => {
      if (!tails.has(i)) {
        const d = probes[i]?.duration ?? 0;
        tails.set(i, d > 0 ? await this.fingerprint(list[i].absPath, tailStart(i), d - tailStart(i)) : null);
      }
      return tails.get(i)!;
    };
    const found: SkipMarks[] = list.map(() => ({}));
    // Every outro an episode shares with a neighbour, as its credits start where the earliest one does: one neighbour
    // can share only the end of it (Archer S1E02 shares 16 s of E03's, the rest share 27 s more).
    const outros: Outro[][] = list.map(() => []);
    // Likewise every intro: a season can have more than one edit of its titles (Game of Thrones S1 has three), and a
    // neighbour with another edit shares only their first bars, so the longest one shared wins.
    const openings: TimeRange[][] = list.map(() => []);
    const compared = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      if (this.closed) return;
      if (this.heard(list[i].item, list.length)) continue;
      // The nearest episodes first: they're the likeliest to share the season's theme as it is now.
      const partners = [i + 1, i - 1, i + 2, i - 2].filter((j) => j >= 0 && j < list.length);
      for (const j of partners) {
        const pair = `${Math.min(i, j)}|${Math.max(i, j)}`;
        if (compared.has(pair)) continue;
        compared.add(pair);
        const [ha, hb] = [await headOf(i), await headOf(j)];
        const opening = ha && hb ? sharedStretch(ha, hb, INTRO_MIN, INTRO_MAX) : null;
        if (opening) {
          openings[i].push(opening.a);
          openings[j].push(opening.b);
        }
        const [a, b] = [await tailOf(i), await tailOf(j)];
        const hit = a && b ? sharedStretch(a, b, CREDITS_MIN) : null;
        if (hit) {
          outros[i].push({ start: round(tailStart(i) + hit.a.start), length: hit.a.end - hit.a.start });
          outros[j].push({ start: round(tailStart(j) + hit.b.start), length: hit.b.end - hit.b.start });
        }
      }
    }
    for (let i = 0; i < list.length; i++) {
      found[i].credits = outroStart(outros[i]);
      found[i].intro = openings[i].reduce<TimeRange | null>((best, r) => (!best || r.end - r.start > best.end - best.start ? r : best), null);
    }
    const marks: SkipMarks[] = [];
    for (let i = 0; i < list.length; i++) {
      if (this.closed) return;
      const e = list[i];
      const entry = this.heard(e.item, list.length) ? this.cache[e.item.id] : null;
      if (entry && (Markers.retried(entry) || (entry.marks.credits == null && entry.creditsRetried !== CREDITS_RETRY))) marks[i] = await this.combine(e.absPath, probes[i]?.chapters ?? [], entry.sound ?? {}, probes[i]?.duration ?? 0, tailStart(i));
      else if (entry) marks[i] = { ...entry.marks };
      else marks[i] = await this.combine(e.absPath, probes[i]?.chapters ?? [], found[i], probes[i]?.duration ?? 0, tailStart(i));
    }
    // Credits a second time: an episode still without them is searched for the outro of the nearest episodes that
    // have them, at every offset (two encodes of the same music don't always share the exact points the first search
    // starts from), and a shorter stretch will do, since it's known to be the outro. Only a match on the outro's start
    // says where the credits start; when only the logos at its end match, the credits play over other music and are
    // found by walking back from the logos through the picture.
    for (let i = 0; i < list.length; i++) {
      if (this.closed) return;
      if (marks[i].credits != null || this.fresh(list[i].item, list.length)) continue;
      const tail = await tailOf(i);
      if (!tail) continue;
      const known = list.map((_, j) => j).filter((j) => j !== i && marks[j].credits != null).sort((x, y) => Math.abs(x - i) - Math.abs(y - i)).slice(0, 4);
      let sting: number | null = null;
      for (const j of known) {
        const theirs = await tailOf(j);
        const from = Math.round((marks[j].credits! - tailStart(j)) / POINT_SECONDS);
        if (!theirs || from < 0 || from >= theirs.length) continue;
        const hit = findClip(tail, theirs.subarray(from, from + Math.round(OUTRO_CLIP / POINT_SECONDS)), STING_MIN);
        if (!hit) continue;
        if (hit.from <= OUTRO_START && hit.end - hit.start >= CREDITS_RETRY_MIN) {
          marks[i].credits = await this.walkBack(list[i].absPath, round(tailStart(i) + hit.start), tailStart(i));
          sting = null;
          break;
        }
        if (hit.from > OUTRO_START) sting ??= tailStart(i) + hit.start;
      }
      if (sting != null) {
        const start = Math.max(tailStart(i), sting - 180);
        const frames = await this.blackness(list[i].absPath, start, sting - start);
        const at = frames ? creditsBefore(frames, sting - start) : null;
        if (at != null) marks[i].credits = round(start + at);
      }
    }
    // Recaps: each episode's opening against the episode before it (all of it) and the openings and endings of the
    // ones before that. Specials aren't in order, so they have nothing to recap.
    const fulls = new Map<number, Uint32Array | null>();
    const fullOf = async (i: number) => {
      if (!fulls.has(i)) {
        const d = probes[i]?.duration ?? 0;
        fulls.set(i, d > 0 ? await this.fingerprint(list[i].absPath, 0, d, 20 * 60_000) : null);
      }
      return fulls.get(i)!;
    };
    // A theme plays in most episodes. Sound only two episodes share (a recap reusing the other's opening scene) isn't
    // one; with three or more episodes that's told apart. What every episode's opening shares is kept for the recaps.
    const shared: TimeRange[][] = [];
    for (let i = 0; i < list.length; i++) {
      if (this.closed) return;
      if (fresh(i)) continue;
      const head = await headOf(i);
      const others: Uint32Array[] = [];
      for (let k = 0; k < list.length && head; k++) {
        const h = k === i ? null : await headOf(k);
        if (h) others.push(h);
      }
      shared[i] = head ? recurring(head, others) : [];
      const intro = marks[i].intro;
      const chapterList = probes[i]?.chapters ?? [];
      if (intro && !chapterMarks(chapterList).intro && !introChapter(intro, chapterList) && others.length >= 2) {
        const covered = shared[i].reduce((sum, r) => sum + Math.max(0, Math.min(intro.end, r.end) - Math.max(intro.start, r.start)), 0);
        if (covered < (intro.end - intro.start) / 2) marks[i].intro = null;
      }
    }
    const ignoreIn = (j: number) => (t: number) => {
      const { intro, credits } = marks[j];
      return t < 15 || (intro != null && t >= intro.start && t <= intro.end) || (credits != null && t >= credits);
    };
    let intros = 0;
    let credits = 0;
    let recaps = 0;
    for (let i = 0; i < list.length; i++) {
      if (this.closed) return;
      const e = list[i];
      if (fresh(i)) {
        const known = this.cache[e.item.id].marks;
        if (known.intro) intros++;
        if (known.credits != null) credits++;
        if (known.recap) recaps++;
        continue;
      }
      const chapters = chapterMarks(probes[i]?.chapters ?? []);
      // Back only for its credits: its recap was already looked for.
      const looked = this.heard(e.item, list.length) && !!this.cache[e.item.id].recapLooked && !(i === 0 && previous);
      const head = looked ? null : await headOf(i);
      const intro = marks[i].intro ?? null;
      let detected: TimeRange | null = null;
      if (head && i > 0 && ep.season !== 0) {
        this.log(`${name}: recap check, episode ${e.item.episode!.episode} (${i + 1} of ${list.length})`);
        const sources: RecapSource[] = [];
        const before = await fullOf(i - 1);
        if (before) sources.push({ points: before, from: 0, ignore: ignoreIn(i - 1) });
        for (let j = i - 2; j >= 0; j--) {
          const [h, t] = [await headOf(j), await tailOf(j)];
          if (h) sources.push({ points: h, from: 0, ignore: ignoreIn(j) });
          if (t) sources.push({ points: t, from: tailStart(j), ignore: ignoreIn(j) });
        }
        detected = findRecap(head, [...(intro ? [intro] : []), ...shared[i]], sources);
      } else if (head && i === 0 && previous?.length) {
        this.log(`${name}: recap check, episode ${e.item.episode!.episode} against season ${ep.season - 1}`);
        detected = findRecap(head, [...(intro ? [intro] : []), ...shared[i]], await this.seasonSources(previous));
      }
      const named = chapters.recap ?? null;
      // A recap chapter says where the recap is, unless the clips run on past where it says it ends.
      const recap = looked
        ? marks[i].recap ?? null
        : named && detected && overlaps(named, detected) ? { start: Math.min(named.start, detected.start), end: Math.max(named.end, detected.end) } : named ?? detected;
      const m = { ...marks[i], intro, recap };
      if (m.intro) intros++;
      if (m.credits != null) credits++;
      if (m.recap) recaps++;
      const entry = this.heard(e.item, list.length) ? this.cache[e.item.id] : null;
      this.set(e.item, {
        marks: m,
        peers: entry ? entry.peers ?? list.length : list.length,
        sound: entry ? entry.sound : { intro: found[i].intro ?? null, credits: found[i].credits ?? null },
        recapLooked: i === 0 && previous ? OPENER_RECAP : true,
        creditsRetried: CREDITS_RETRY,
        walked: WALKED,
      });
    }
    const missing = this.missingCredits(list);
    this.listed.add(`${ep.show}|${ep.season}`);
    this.log(`${name}: intros in ${intros} of ${list.length}, recaps in ${recaps}, credits in ${credits} (${Math.round((Date.now() - started) / 1000)} s)${missing ? ` ${missing.text}` : ""}`);
  }

  /**
   * What a season's first episode may recap from the season before: all of its last episode, and the openings and
   * endings of the rest, their own intros and credits left out.
   */
  private async seasonSources(previous: MarkersEntry[]): Promise<RecapSource[]> {
    const sources: RecapSource[] = [];
    for (let j = previous.length - 1; j >= 0; j--) {
      if (this.closed) break;
      const e = previous[j];
      const probe = await this.probe(e.absPath);
      const d = probe?.duration ?? 0;
      if (d <= 0) continue;
      const { intro, credits } = this.cache[e.item.id]?.marks ?? {};
      const ignore = (t: number) => t < 15 || (intro != null && t >= intro.start && t <= intro.end) || (credits != null && t >= credits);
      if (j === previous.length - 1) {
        const all = await this.fingerprint(e.absPath, 0, d, 20 * 60_000);
        if (all) sources.push({ points: all, from: 0, ignore });
        continue;
      }
      const tail = Math.max(0, d - Math.min(CREDITS_WINDOW, d / 5));
      const [h, t] = [await this.fingerprint(e.absPath, 0, Math.min(INTRO_WINDOW, d / 4)), await this.fingerprint(e.absPath, tail, d - tail)];
      if (h) sources.push({ points: h, from: 0, ignore });
      if (t) sources.push({ points: t, from: tail, ignore });
    }
    return sources;
  }

  private static seasonName(list: MarkersEntry[]): string {
    const ep = list[0].item.episode!;
    return `${ep.show} ${ep.season === 0 ? "specials" : `season ${ep.season}`}`;
  }

  /** The season's episodes without credits, as "(none found in E03, E07)", when some have them and some don't. */
  private missingCredits(list: MarkersEntry[]): { count: number; text: string } | null {
    const without = list.filter((e) => this.get(e.item)?.credits == null).map((e) => `E${String(e.item.episode!.episode).padStart(2, "0")}`);
    if (!without.length || without.length === list.length) return null;
    return { count: without.length, text: `(none found in ${without.join(", ")})` };
  }

  /**
   * An episode's marks: its chapter names say it best, then what sound found, and for credits last of all the picture
   * (white text on black), looked at only when neither found them.
   */
  private async combine(file: string, chapterList: { start: number; end: number; title: string }[], sound: SkipMarks, duration: number, tail: number): Promise<SkipMarks> {
    const chapters = chapterMarks(chapterList);
    let credits = chapters.credits ?? sound.credits ?? null;
    if (chapters.credits != null) credits = await this.chapterCards(file, chapters.credits);
    if (chapters.credits == null && sound.credits != null) credits = await this.walkBack(file, sound.credits, tail);
    if (credits == null && duration > 0) {
      // Keyframes first, as they're quick to read. Credit cards are still pictures, so keyframes can be half a minute
      // apart there: a long gap between dark ones doesn't end the stretch. Then every half second around where it
      // seems to start, to find the exact second (and keep out a dark scene just before).
      const frames = await this.blackness(file, tail, duration - tail);
      const rough = frames ? blackCredits(frames, duration - tail, KEYFRAME_GAP) : null;
      if (rough != null) {
        const from = Math.max(0, rough - 60);
        const close = await this.blackness(file, tail + from, duration - tail - from, true);
        const at = close ? blackCredits(close, duration - tail - from, 12, CLOSE_ODD, CLOSE_BLACK) : null;
        credits = round(tail + (at != null ? from + at : rough));
      }
    }
    const heard = sound.intro ? introChapter(sound.intro, chapterList) ?? sound.intro : null;
    return { intro: chapters.intro ?? heard, recap: chapters.recap ?? null, credits };
  }

  /** Where the cards of a credits chapter starting at [credits] start: later than it says when it starts early. */
  private async chapterCards(file: string, credits: number): Promise<number> {
    const frames = await this.blackness(file, credits, CHAPTER_EARLY + CHAPTER_EARLY_CARDS + 1, true, CARD_BLACK);
    const at = frames ? cardsAfter(frames) : null;
    if (at == null) return credits;
    const moved = round(credits + at);
    this.log(`${path.basename(file)}: credits start at ${clock(moved)}, where the cards do (the credits chapter starts at ${clock(credits)})`);
    return moved;
  }

  /** [credits] found by sound, moved back to where the credit cards start when they're already showing there. */
  private async walkBack(file: string, credits: number, tail: number): Promise<number> {
    const start = Math.max(tail, credits - WALK_BACK);
    const frames = await this.blackness(file, start, credits - start + 2, true, CARD_BLACK);
    const at = frames ? cardsBefore(frames, credits - start) : null;
    if (at == null) return credits;
    const moved = round(start + at);
    this.log(`${path.basename(file)}: credits start at ${clock(moved)}, where the cards do (the sound match only lined up from ${clock(credits)})`);
    return moved;
  }

  /** An episode whose credits came from sound, checked once for cards that start before them. Whether they moved. */
  private async walk(e: MarkersEntry): Promise<boolean> {
    const entry = this.cache[e.item.id];
    const probe = await this.probe(e.absPath);
    if (!probe) return false;
    // From where sound put them, so an earlier walk back that went too far is undone.
    const credits = entry.sound!.credits!;
    const d = probe.duration;
    const tail = Math.max(0, d - Math.min(CREDITS_WINDOW, d / 5));
    const at = chapterMarks(probe.chapters).credits != null ? entry.marks.credits : d > 0 ? await this.walkBack(e.absPath, credits, tail) : credits;
    this.cache[e.item.id] = { ...entry, marks: { ...entry.marks, credits: at }, walked: WALKED };
    return at !== entry.marks.credits;
  }

  /**
   * How black (%) each keyframe is over [length] seconds from [start] (only keyframes are decoded, so it's quick), or
   * with [every], two frames a second (everything is decoded, so only for a few minutes).
   */
  private async blackness(file: string, start: number, length: number, every = false, threshold = 32): Promise<{ t: number; black: number }[] | null> {
    if (length < CREDITS_MIN) return null;
    const filter = `${every ? "fps=2," : ""}scale=128:-2,blackframe=amount=0:threshold=${threshold},metadata=print:file=-`;
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", ...(every ? [] : ["-skip_frame", "nokey"]), "-ss", String(start), "-i", file, "-t", String(length), "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filter, "-f", "null", "-"];
    const r = await run(this.config.ffmpeg, args, 5 * 60_000);
    if (r.code !== 0) return null;
    const frames: { t: number; black: number }[] = [];
    let t: number | null = null;
    for (const line of r.out.toString("utf8").split("\n")) {
      const time = /pts_time:([\d.]+)/.exec(line);
      if (time) t = Number(time[1]);
      const black = /pblack=(\d+)/.exec(line);
      if (black && t != null) frames.push({ t, black: Number(black[1]) });
    }
    return frames;
  }

  /**
   * Version 1 marks, brought up to date without listening again: chapter names are read anew (joined, short ones
   * dropped), what sound found is kept, and episodes without credits get the picture check.
   */
  private async upgrade(e: MarkersEntry): Promise<void> {
    const entry = this.cache[e.item.id];
    const probe = await this.probe(e.absPath);
    if (!probe) return;
    const old = oldChapterMarks(probe.chapters);
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    // What version 1 kept that its chapter names didn't give came from sound.
    const sound: SkipMarks = {
      intro: entry.marks.intro && !same(entry.marks.intro, old.intro) ? entry.marks.intro : null,
      credits: entry.marks.credits != null && !same(entry.marks.credits, old.credits) ? entry.marks.credits : null,
    };
    const d = probe.duration;
    const tail = Math.max(0, d - Math.min(CREDITS_WINDOW, d / 5));
    const marks = e.item.episode ? await this.combine(e.absPath, probe.chapters, sound, d, tail) : chapterMarks(probe.chapters);
    this.set(e.item, { marks, peers: entry.peers ?? 1, sound: { intro: sound.intro ?? null, credits: sound.credits ?? null }, walked: WALKED });
  }

  private set(item: MediaItem, entry: { marks: SkipMarks; peers: number; sound?: SkipMarks; recapLooked?: boolean | number; creditsRetried?: boolean | number; walked?: boolean | number }): void {
    this.cache[item.id] = { key: Markers.key(item), v: VERSION, ...entry };
  }

  private async probe(file: string): Promise<{ duration: number; chapters: { start: number; end: number; title: string }[] } | null> {
    const r = await run(this.config.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_chapters", file], 30_000);
    if (r.code !== 0) return null;
    try {
      const json = JSON.parse(r.out.toString("utf8"));
      const chapters = (Array.isArray(json.chapters) ? json.chapters : []).map((c: any) => ({
        start: Number(c.start_time) || 0,
        end: Number(c.end_time) || 0,
        title: String(c.tags?.title ?? ""),
      }));
      return { duration: Number(json.format?.duration) || 0, chapters };
    } catch {
      return null;
    }
  }

  /** Chromaprint points for [length] seconds of the file's sound from [start], or null when ffmpeg can't. */
  private async fingerprint(file: string, start: number, length: number, timeoutMs = 5 * 60_000): Promise<Uint32Array | null> {
    if (length < INTRO_MIN) return null;
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", String(start), "-i", file, "-t", String(length), "-vn", "-sn", "-dn", "-ac", "1", "-f", "chromaprint", "-fp_format", "raw", "pipe:1"];
    const r = await run(this.config.ffmpeg, args, timeoutMs);
    if (r.code !== 0 || r.out.length < 4) return null;
    const out = new Uint32Array(r.out.length >> 2);
    for (let i = 0; i < out.length; i++) out[i] = r.out.readUInt32LE(i * 4);
    return out;
  }

  private async load(): Promise<void> {
    if (!this.config.file) return;
    try {
      const json = JSON.parse(await fs.readFile(this.config.file, "utf8"));
      if (json && typeof json === "object" && json.files && typeof json.files === "object") this.cache = json.files;
    } catch {}
  }

  /** Reads the skip times set by hand again when their file has changed; a file that doesn't read keeps the last ones. */
  private async loadHand(): Promise<void> {
    const file = this.config.handFile;
    if (!file) return;
    let changed: number;
    try {
      changed = (await fs.stat(file)).mtimeMs;
    } catch {
      return;
    }
    if (changed === this.handChanged) return;
    this.handChanged = changed;
    try {
      const json = JSON.parse(await fs.readFile(file, "utf8"));
      const hand: Record<string, HandSet> = {};
      let bad = 0;
      for (const [id, raw] of Object.entries(json && typeof json === "object" ? json : {})) {
        const set = handSet(raw);
        if (set) hand[id] = set;
        else bad++;
      }
      this.hand = hand;
      this.log(`${Object.keys(hand).length} videos with skip times set by hand${bad ? ` (${bad} left out: not valid)` : ""}`);
    } catch (err) {
      this.log(`couldn't read ${path.basename(file)}, keeping the skip times set by hand before: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async saveHand(): Promise<void> {
    const file = this.config.handFile;
    if (!file) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    // Laid out to be read and edited by hand.
    await fs.writeFile(tmp, JSON.stringify(this.hand, null, 2) + "\n");
    await fs.rename(tmp, file);
    this.handChanged = (await fs.stat(file)).mtimeMs;
  }

  private async save(): Promise<void> {
    if (!this.config.file) return;
    await fs.mkdir(path.dirname(this.config.file), { recursive: true });
    const tmp = `${this.config.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ files: this.cache }));
    await fs.rename(tmp, this.config.file);
  }
}
