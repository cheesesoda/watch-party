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
const VERSION = 2;
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
 * Where the credits start, going by the picture: the last stretch of keyframes that are nearly all black (white text
 * on black), at least 20 s long and reaching to within 30 s of the end (logos may follow). One odd keyframe inside is
 * fine; two in a row end the stretch. [frames] are seconds from the start of the window and % black; [length] is the
 * window's length.
 */
export function blackCredits(frames: { t: number; black: number }[], length: number): number | null {
  const dark = (i: number) => frames[i].black >= CREDITS_BLACK;
  let i = frames.length - 1;
  while (i >= 0 && !dark(i) && length - frames[i].t <= 30) i--;
  if (i < 0 || !dark(i) || length - frames[i].t > 30) return null;
  const lastDark = frames[i].t;
  let start = i;
  let bright = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (dark(j)) {
      start = j;
      bright = 0;
    } else if (++bright >= 2 || frames[start].t - frames[j].t > 12) break;
  }
  return lastDark - frames[start].t >= 20 ? frames[start].t : null;
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
  /** Whether the episode's opening has been checked against earlier episodes for a recap. */
  recapLooked?: boolean;
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
    this.loaded = this.load();
  }

  private static key(item: MediaItem): string {
    return `${item.size}:${item.addedAt ?? 0}`;
  }

  /** What's known about this file's intro, recap and credits; undefined until it has been looked at, or if none. */
  get(item: MediaItem): SkipMarks | undefined {
    const entry = this.cache[item.id];
    if (!entry || entry.key !== Markers.key(item)) return undefined;
    const { intro, recap, credits } = entry.marks;
    return intro || recap || credits != null ? entry.marks : undefined;
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
    return this.heard(item, peers) && (!item.episode || !!this.cache[item.id].recapLooked);
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
    for (const list of seasons.values()) {
      if (this.closed) return;
      list.sort((x, y) => x.item.episode!.episode - y.item.episode!.episode);
      if (list.every((e) => this.fresh(e.item, list.length))) {
        // Looked at before: no listening, but name the episodes still without credits once per start.
        const missing = this.missingCredits(list);
        const key = `${list[0].item.episode!.show}|${list[0].item.episode!.season}`;
        if (missing && !this.listed.has(key)) this.log(`${Markers.seasonName(list)}: credits in ${list.length - missing.count} of ${list.length} ${missing.text}`);
        this.listed.add(key);
        continue;
      }
      await this.season(list);
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

  private async season(list: MarkersEntry[]): Promise<void> {
    const started = Date.now();
    const ep = list[0].item.episode!;
    const name = Markers.seasonName(list);
    const listen = list.filter((e) => !this.heard(e.item, list.length)).length;
    this.log(`${name}: ${listen ? `listening for intros and credits in ${listen} of ${list.length} episodes` : "checking for recaps"}`);
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
    for (let i = 0; i < list.length; i++) {
      if (this.closed) return;
      if (this.heard(list[i].item, list.length)) continue;
      // The nearest episodes first: they're the likeliest to share the season's theme as it is now.
      const partners = [i + 1, i - 1, i + 2, i - 2].filter((j) => j >= 0 && j < list.length);
      for (const j of partners) {
        if (found[i].intro && found[i].credits != null) break;
        if (!found[i].intro) {
          const [a, b] = [await headOf(i), await headOf(j)];
          const hit = a && b ? sharedStretch(a, b, INTRO_MIN, INTRO_MAX) : null;
          if (hit) {
            found[i].intro = hit.a;
            found[j].intro ??= hit.b;
          }
        }
        if (found[i].credits == null) {
          const [a, b] = [await tailOf(i), await tailOf(j)];
          const hit = a && b ? sharedStretch(a, b, CREDITS_MIN) : null;
          if (hit) {
            found[i].credits = round(tailStart(i) + hit.a.start);
            found[j].credits ??= round(tailStart(j) + hit.b.start);
          }
        }
      }
    }
    const marks: SkipMarks[] = [];
    for (let i = 0; i < list.length; i++) {
      if (this.closed) return;
      const e = list[i];
      if (this.heard(e.item, list.length)) marks[i] = { ...this.cache[e.item.id].marks };
      else marks[i] = await this.combine(e.absPath, probes[i]?.chapters ?? [], found[i], probes[i]?.duration ?? 0, tailStart(i));
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
      if (this.fresh(list[i].item, list.length)) continue;
      const head = await headOf(i);
      const others: Uint32Array[] = [];
      for (let k = 0; k < list.length && head; k++) {
        const h = k === i ? null : await headOf(k);
        if (h) others.push(h);
      }
      shared[i] = head ? recurring(head, others) : [];
      const intro = marks[i].intro;
      if (intro && !chapterMarks(probes[i]?.chapters ?? []).intro && others.length >= 2) {
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
      if (this.fresh(e.item, list.length)) {
        const known = this.cache[e.item.id].marks;
        if (known.intro) intros++;
        if (known.credits != null) credits++;
        if (known.recap) recaps++;
        continue;
      }
      const chapters = chapterMarks(probes[i]?.chapters ?? []);
      const head = await headOf(i);
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
      }
      const named = chapters.recap ?? null;
      // A recap chapter says where the recap is, unless the clips run on past where it says it ends.
      const recap = named && detected && overlaps(named, detected) ? { start: Math.min(named.start, detected.start), end: Math.max(named.end, detected.end) } : named ?? detected;
      const m = { ...marks[i], intro, recap };
      if (m.intro) intros++;
      if (m.credits != null) credits++;
      if (m.recap) recaps++;
      const entry = this.heard(e.item, list.length) ? this.cache[e.item.id] : null;
      this.set(e.item, {
        marks: m,
        peers: entry ? entry.peers ?? list.length : list.length,
        sound: entry ? entry.sound : { intro: found[i].intro ?? null, credits: found[i].credits ?? null },
        recapLooked: true,
      });
    }
    const missing = this.missingCredits(list);
    this.listed.add(`${ep.show}|${ep.season}`);
    this.log(`${name}: intros in ${intros} of ${list.length}, recaps in ${recaps}, credits in ${credits} (${Math.round((Date.now() - started) / 1000)} s)${missing ? ` ${missing.text}` : ""}`);
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
    if (credits == null && duration > 0) {
      const frames = await this.blackness(file, tail, duration - tail);
      const at = frames ? blackCredits(frames, duration - tail) : null;
      if (at != null) credits = round(tail + at);
    }
    return { intro: chapters.intro ?? sound.intro ?? null, recap: chapters.recap ?? null, credits };
  }

  /** How black (%) each keyframe is over [length] seconds from [start] (only keyframes are decoded, so it's quick). */
  private async blackness(file: string, start: number, length: number): Promise<{ t: number; black: number }[] | null> {
    if (length < CREDITS_MIN) return null;
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-skip_frame", "nokey", "-ss", String(start), "-i", file, "-t", String(length), "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", "scale=128:-2,blackframe=amount=0:threshold=32,metadata=print:file=-", "-f", "null", "-"];
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
    this.set(e.item, { marks, peers: entry.peers ?? 1, sound: { intro: sound.intro ?? null, credits: sound.credits ?? null } });
  }

  private set(item: MediaItem, entry: { marks: SkipMarks; peers: number; sound?: SkipMarks; recapLooked?: boolean }): void {
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

  private async save(): Promise<void> {
    if (!this.config.file) return;
    await fs.mkdir(path.dirname(this.config.file), { recursive: true });
    const tmp = `${this.config.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ files: this.cache }));
    await fs.rename(tmp, this.config.file);
  }
}
