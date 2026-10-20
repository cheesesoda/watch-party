import fs from "node:fs";
import path from "node:path";

/** A party set up for later, as kept on disk: ids only, so it follows renamed or re-matched files. */
export interface Planned {
  /** The party code, the same before and after it opens. */
  id: string;
  /** The videos to play, in order (one for a movie). */
  queue: string[];
  /** When it starts (ms since epoch). */
  at: number;
  /** Who scheduled it, for "Jake's party" on the invite. */
  host: string | null;
  createdAt: number;
}

/** How long before the start time the party opens, so friends can join and wait for the host. */
export const OPENS_EARLY_MS = 30 * 60_000;
/** A party the server was off for: still opened when it comes back within this long after the start time. */
export const LATE_MS = 6 * 60 * 60_000;

/**
 * Parties scheduled for later (Schedule on a movie or show page). Kept in a small JSON file so they survive the PC
 * being off for days; without a file (tests) they live in memory only. They become ordinary parties at [opens].
 */
export class Schedule {
  private planned: Planned[] = [];

  constructor(
    private file?: string,
    private now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved)) this.planned = saved.filter(isPlanned);
    } catch {
      // No file yet, or an unreadable one: start empty.
    }
  }

  /** Coming up, soonest first. Ones the server missed by more than LATE_MS are dropped. */
  list(): Planned[] {
    const cutoff = this.now() - LATE_MS;
    const fresh = this.planned.filter((p) => p.at > cutoff);
    if (fresh.length !== this.planned.length) {
      this.planned = fresh;
      this.write();
    }
    return [...this.planned].sort((a, b) => a.at - b.at);
  }

  get(id: string): Planned | undefined {
    return this.list().find((p) => p.id === id.toLowerCase());
  }

  has(id: string): boolean {
    return this.planned.some((p) => p.id === id);
  }

  add(id: string, queue: string[], at: number, host: string | null): Planned {
    const planned: Planned = { id, queue, at, host, createdAt: this.now() };
    this.planned.push(planned);
    this.write();
    return planned;
  }

  remove(id: string): boolean {
    const before = this.planned.length;
    this.planned = this.planned.filter((p) => p.id !== id.toLowerCase());
    if (this.planned.length === before) return false;
    this.write();
    return true;
  }

  /** The ones whose time to open has come, taken off the list. */
  takeDue(): Planned[] {
    const now = this.now();
    const due = this.list().filter((p) => opens(p) <= now);
    for (const p of due) this.remove(p.id);
    return due;
  }

  private write(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.planned));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`schedule: couldn't save ${this.file}: ${(err as Error).message}`);
    }
  }
}

/** When friends can start joining it. */
export const opens = (p: Planned) => p.at - OPENS_EARLY_MS;

function isPlanned(v: unknown): v is Planned {
  const p = v as Planned;
  return (
    !!p &&
    typeof p.id === "string" &&
    typeof p.at === "number" &&
    typeof p.createdAt === "number" &&
    Array.isArray(p.queue) &&
    p.queue.length > 0 &&
    p.queue.every((id) => typeof id === "string") &&
    (p.host === null || typeof p.host === "string")
  );
}
