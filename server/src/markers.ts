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

const RECAP = /\b(recap|previously)\b/;
const INTRO = /^(intro|introduction|opening|opening credits|opening titles|op|title sequence|main titles?|theme song)$/;
const LOGO = /\blogo\b/;
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
  // A "Previously On" chapter of a few seconds only marks where the recap starts (Amazon's, as on Reacher): it runs on
  // to the studio logo (or the intro) that starts the episode, when one comes within two minutes.
  const recap = marks.recap;
  if (recap && recap.end - recap.start < SKIP_MIN) {
    const next = chapters.find((c) => c.start >= recap.end && c.start - recap.start <= 120 && (LOGO.test(c.title.trim().toLowerCase()) || INTRO.test(c.title.trim().toLowerCase())));
    if (next) recap.end = round(next.start);
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
}

export interface MarkersEntry {
  absPath: string;
  item: MediaItem;
}

/**
 * Finds where episodes' intros and credits are, the way Plex and Jellyfin's Intro Skipper do: the episodes of a season
 * share their theme, so a stretch of sound that two episodes both have near the start is the intro, and near the end
 * the credits. ffmpeg's chromaprint (the fingerprint AcoustID uses) turns the sound into comparable points. Chapter
 * names, when a file has them, win, and are the only way recaps are found. Runs in the background, one file at a time,
 * and keeps what it found in data/markers.json.
 */
export class Markers {
  private cache: Record<string, Entry> = {};
  private loaded: Promise<void>;
  private running: Promise<void> = Promise.resolve();
  private latest: MarkersEntry[] | null = null;
  private busy = false;
  private closed = false;

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

  private fresh(item: MediaItem, peers: number): boolean {
    const entry = this.cache[item.id];
    if (!entry || entry.key !== Markers.key(item) || entry.v !== VERSION) return false;
    const { intro, credits } = entry.marks;
    return (intro != null && credits != null) || (entry.peers ?? 0) >= peers;
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
    for (const e of old) {
      if (this.closed) return;
      await this.upgrade(e);
    }
    if (old.length) {
      this.log(`updated ${old.length} earlier results (chapters joined, credits by picture)`);
      await this.save();
    }
    for (const list of seasons.values()) {
      if (this.closed) return;
      list.sort((x, y) => x.item.episode!.episode - y.item.episode!.episode);
      if (list.every((e) => this.fresh(e.item, list.length))) continue;
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
      if (this.fresh(list[i].item, list.length)) continue;
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
    let intros = 0;
    let credits = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (this.fresh(e.item, list.length)) {
        const known = this.cache[e.item.id].marks;
        if (known.intro) intros++;
        if (known.credits != null) credits++;
        continue;
      }
      const d = probes[i]?.duration ?? 0;
      const marks = await this.combine(e.absPath, probes[i]?.chapters ?? [], found[i], d, tailStart(i));
      if (marks.intro) intros++;
      if (marks.credits != null) credits++;
      this.set(e.item, { marks, peers: list.length, sound: { intro: found[i].intro ?? null, credits: found[i].credits ?? null } });
    }
    const name = `${ep.show} ${ep.season === 0 ? "specials" : `season ${ep.season}`}`;
    this.log(`${name}: intros in ${intros} of ${list.length}, credits in ${credits} (${Math.round((Date.now() - started) / 1000)} s)`);
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

  private set(item: MediaItem, entry: { marks: SkipMarks; peers: number; sound?: SkipMarks }): void {
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
  private async fingerprint(file: string, start: number, length: number): Promise<Uint32Array | null> {
    if (length < INTRO_MIN) return null;
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", String(start), "-i", file, "-t", String(length), "-vn", "-sn", "-dn", "-ac", "1", "-f", "chromaprint", "-fp_format", "raw", "pipe:1"];
    const r = await run(this.config.ffmpeg, args, 5 * 60_000);
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
