import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { HealthIssue, HealthReport, MediaItem, MediaInfo } from "../../shared/protocol.ts";

/** Spots read in each file to look for blank data, evenly spread through it. */
const SPOTS = 32;
/** Bytes read at each spot. Compressed video never has this many zero bytes in a row; a copy that stopped partway does. */
const CHUNK = 64 * 1024;
/** The first bit of a file can hold padding (MKV void elements, AVI JUNK chunks), so blank data there doesn't count. */
const SKIP_START = 0.01;
/** Below 720p: not as tall as 700 lines and narrower than 1200 (a 1280×536 widescreen 720p isn't low resolution). */
const LOW_HEIGHT = 700;
const LOW_WIDTH = 1200;

export interface HealthEntry {
  absPath: string;
  item: MediaItem;
}

interface Checked {
  /** size:addedAt, so a file is checked again only when it changes. */
  key: string;
  issue: Omit<HealthIssue, "id" | "relPath" | "path"> | null;
}

const keyOf = (item: MediaItem) => `${item.size}:${item.addedAt}`;

function clock(t: number): string {
  const s = Math.round(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Whether the CHUNK bytes at [offset] are all zero (false past the end). */
async function blankAt(file: fsp.FileHandle, offset: number, size: number): Promise<boolean> {
  const length = Math.min(CHUNK, size - offset);
  if (length <= 0) return false;
  const buf = Buffer.alloc(length);
  const { bytesRead } = await file.read(buf, 0, length, offset);
  if (bytesRead < length) return false;
  for (let i = 0; i < length; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * The blank stretch in a file, as fractions of its size, or null. Reads SPOTS spots, then narrows down where the first
 * blank stretch starts and ends by halving, so the times are close (a few seconds) without reading the whole file.
 */
export async function findBlank(absPath: string, size: number): Promise<{ from: number; to: number } | "all" | null> {
  const file = await fsp.open(absPath, "r");
  try {
    const at = (i: number) => Math.floor(((i + 0.5) / SPOTS) * size);
    const blank: boolean[] = [];
    for (let i = 0; i < SPOTS; i++) blank.push(await blankAt(file, at(i), size));
    if (blank.every(Boolean) && (await blankAt(file, 0, size))) return "all";
    const first = blank.findIndex((b, i) => b && at(i) >= size * SKIP_START);
    if (first < 0) return null;
    let last = first;
    while (last + 1 < SPOTS && blank[last + 1]) last++;
    // The edge lies between a spot with data and a blank one; halve the gap until it's one chunk wide.
    const edge = async (data: number, empty: number) => {
      while (Math.abs(empty - data) > CHUNK) {
        const mid = Math.floor((data + empty) / 2);
        if (await blankAt(file, mid, size)) empty = mid;
        else data = mid;
      }
      return empty;
    };
    const from = await edge(first > 0 ? at(first - 1) : Math.floor(size * SKIP_START), at(first));
    const to = last + 1 < SPOTS ? await edge(at(last + 1), at(last)) + CHUNK : size;
    return { from: from / size, to: Math.min(1, to / size) };
  } finally {
    await file.close();
  }
}

/** What's wrong with one file, or null when it looks fine. [info]: ffprobe's look at it (null when it couldn't read it). */
export async function checkFile(absPath: string, size: number, info: MediaInfo | null): Promise<Checked["issue"]> {
  if (size === 0) return { kind: "broken", detail: "Empty file (0 bytes)" };
  const blank = await findBlank(absPath, size).catch(() => null);
  if (blank === "all") return { kind: "broken", detail: "Blank file (all zeros)" };
  if (!info || !(info.duration > 0)) return { kind: "broken", detail: "The server can't read it" };
  if (!info.video) return { kind: "broken", detail: "No picture in this file" };
  if (blank) {
    const to = blank.to >= 0.999 ? "the end" : `about ${clock(blank.to * info.duration)}`;
    return { kind: "damaged", detail: `Blank from about ${clock(blank.from * info.duration)} to ${to}` };
  }
  const { width, height } = info.video;
  if (height > 0 && height < LOW_HEIGHT && width < LOW_WIDTH) return { kind: "lowres", detail: `${height}p (${width}×${height})` };
  return null;
}

/**
 * Library health: looks at each video once (and again when it changes) for files that won't play well, in the
 * background after a scan. Kept in data/health.json; without a file (tests) it lives in memory only.
 */
export class Health {
  private checked = new Map<string, Checked>();
  private items = new Map<string, MediaItem>();
  private paths = new Map<string, string>();
  private checkedAt: number | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private file: string | undefined,
    private probe: (absPath: string) => Promise<MediaInfo | null>,
    private now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [id, c] of Object.entries(saved.checked ?? {})) this.checked.set(id, c as Checked);
      this.checkedAt = typeof saved.checkedAt === "number" ? saved.checkedAt : null;
    } catch {
      // No file yet, or an unreadable one: check everything.
    }
  }

  /** Checks the videos not checked yet, or changed since; one pass at a time (a call during one runs another after). */
  check(entries: HealthEntry[]): Promise<void> {
    this.items = new Map(entries.map((e) => [e.item.id, e.item]));
    this.paths = new Map(entries.map((e) => [e.item.id, e.absPath]));
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass(entries);
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async pass(entries: HealthEntry[]): Promise<void> {
    let found = 0;
    for (const { absPath, item } of entries) {
      const key = keyOf(item);
      if (this.checked.get(item.id)?.key === key) continue;
      const info = item.size > 0 ? await this.probe(absPath).catch(() => null) : null;
      const issue = await checkFile(absPath, item.size, info);
      this.checked.set(item.id, { key, issue });
      if (issue && issue.kind !== "lowres") {
        found++;
        console.log(`health: ${item.relPath}: ${issue.detail}`);
      }
    }
    for (const id of this.checked.keys()) if (!this.items.has(id)) this.checked.delete(id);
    this.checkedAt = this.now();
    if (found) console.log(`health: ${found} file(s) won't play well; see Library health`);
    await this.save();
  }

  report(): HealthReport {
    const issues: HealthIssue[] = [];
    let checked = 0;
    for (const [id, item] of this.items) {
      const c = this.checked.get(id);
      if (c?.key !== keyOf(item)) continue;
      checked++;
      if (c.issue) issues.push({ id, relPath: item.relPath, path: this.paths.get(id) ?? "", ...c.issue });
    }
    issues.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true }));
    return { issues, checked, total: this.items.size, checkedAt: this.checkedAt };
  }

  private async save(): Promise<void> {
    if (!this.file) return;
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(`${this.file}.tmp`, JSON.stringify({ checkedAt: this.checkedAt, checked: Object.fromEntries(this.checked) }));
      await fsp.rename(`${this.file}.tmp`, this.file);
    } catch (e) {
      console.warn(`couldn't save ${this.file}: ${(e as Error).message}`);
    }
  }
}
