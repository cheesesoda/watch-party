import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A saved spot as kept on disk: ids only, so it follows renamed or re-matched files. */
export interface SavedSpot {
  id: string;
  mediaId: string;
  position: number;
  next: string[];
  savedAt: number;
  /** One spot per show (or movie): saving again replaces the older one. */
  key: string;
}

/** How many spots Home shows, and how long one is kept. */
export const MAX_SPOTS = 6;
export const SPOT_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Where parties stopped ("Pick up where you left off"), newest first. Kept in a small JSON file next to the
 * metadata cache so they survive a restart; without a file (tests) they live in memory only.
 */
export class Spots {
  private spots: SavedSpot[] = [];

  constructor(
    private file?: string,
    private now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved)) this.spots = saved.filter(isSpot);
    } catch {
      // No file yet, or an unreadable one: start empty.
    }
  }

  list(): SavedSpot[] {
    const cutoff = this.now() - SPOT_TTL_MS;
    const fresh = this.spots.filter((s) => s.savedAt > cutoff);
    if (fresh.length !== this.spots.length) {
      this.spots = fresh;
      this.write();
    }
    return [...this.spots];
  }

  add(spot: Omit<SavedSpot, "id" | "savedAt">): SavedSpot {
    const saved: SavedSpot = { ...spot, id: crypto.randomBytes(6).toString("base64url"), savedAt: this.now() };
    this.spots = [saved, ...this.spots.filter((s) => s.key !== spot.key)].slice(0, MAX_SPOTS);
    this.write();
    return saved;
  }

  get(id: string): SavedSpot | undefined {
    return this.list().find((s) => s.id === id);
  }

  remove(id: string): boolean {
    const before = this.spots.length;
    this.spots = this.spots.filter((s) => s.id !== id);
    if (this.spots.length === before) return false;
    this.write();
    return true;
  }

  private write(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.spots, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn(`couldn't save ${this.file}: ${(e as Error).message}`);
    }
  }
}

function isSpot(s: unknown): s is SavedSpot {
  const o = s as SavedSpot;
  return !!o && typeof o.id === "string" && typeof o.mediaId === "string" && typeof o.position === "number" &&
    Array.isArray(o.next) && typeof o.savedAt === "number" && typeof o.key === "string";
}
