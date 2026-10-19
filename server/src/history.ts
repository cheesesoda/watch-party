import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Play, WatchState } from "../../shared/protocol.ts";
import { nearEnd } from "../../shared/protocol.ts";

/** How many plays History keeps, newest first. */
export const MAX_PLAYS = 1000;
/** A video stopped before this far in isn't "partly watched": someone opened it and changed their mind. */
export const MIN_PROGRESS = 60;

/** A party (or Watch alone) as History sees it, each time it's looked at. */
export interface Watching {
  room: string;
  solo: boolean;
  mediaId: string;
  position: number;
  paused: boolean;
  duration: number | null | undefined;
  credits: number | null | undefined;
  names: string[];
}

interface Saved {
  plays: Play[];
  seen: Record<string, WatchState>;
}

/**
 * What has been watched, kept for everyone on the server (friends join with just a name, so there's no telling people
 * apart): each video's watched mark or how far in it got, and a list of plays (one video in one party) for History.
 * Kept in data/history.json; without a file (tests) it lives in memory only.
 */
export class History {
  private plays: Play[] = [];
  private seen = new Map<string, WatchState>();
  /** The play each party is on now, so the next look updates it rather than adding another. */
  private open = new Map<string, Play>();
  private dirty = false;

  constructor(
    private file?: string,
    private now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Saved>;
      if (Array.isArray(saved.plays)) this.plays = saved.plays.filter(isPlay).slice(0, MAX_PLAYS);
      for (const [id, state] of Object.entries(saved.seen ?? {})) if (isState(state)) this.seen.set(id, state);
    } catch {
      // No file yet, or an unreadable one: start empty.
    }
  }

  /**
   * A party as it is now. A video that was never played (still paused at the start) isn't a play yet. Reaching the
   * credits (or the last minute) marks it watched.
   */
  track(w: Watching): void {
    const now = this.now();
    let play = this.open.get(w.room);
    if (!play || play.mediaId !== w.mediaId) {
      if (w.paused && w.position < 1) return;
      play = { id: crypto.randomBytes(6).toString("base64url"), mediaId: w.mediaId, startedAt: now, lastAt: now, position: w.position, names: [], solo: w.solo, watched: false };
      this.open.set(w.room, play);
      this.plays = [play, ...this.plays].slice(0, MAX_PLAYS);
      this.dirty = true;
    }
    const names = merge(play.names, w.names);
    const watched = nearEnd(w.position, w.duration, w.credits);
    if (Math.abs(play.position - w.position) >= 1 || names.length !== play.names.length || play.solo !== w.solo || (watched && !play.watched)) {
      Object.assign(play, { position: w.position, lastAt: now, names, solo: play.solo && w.solo, watched: play.watched || watched });
      this.dirty = true;
    }
    const old = this.seen.get(w.mediaId);
    if (watched) {
      if (!old?.watchedAt || old.position !== null) this.set(w.mediaId, { watchedAt: now, position: null, updatedAt: now });
    } else if (w.position >= MIN_PROGRESS && Math.abs((old?.position ?? -1) - w.position) >= 1) {
      this.set(w.mediaId, { watchedAt: old?.watchedAt ?? null, position: w.position, updatedAt: now });
    }
  }

  /** The party ended: its next video starts a new play. */
  ended(room: string): void {
    this.open.delete(room);
  }

  /** Mark as watched / not watched, by hand. Not watched forgets how far in it got too. */
  mark(ids: string[], watched: boolean): void {
    const now = this.now();
    for (const id of new Set(ids)) {
      if (watched) this.set(id, { watchedAt: now, position: null, updatedAt: now });
      else if (this.seen.delete(id)) this.dirty = true;
    }
    this.save();
  }

  state(id: string): WatchState | undefined {
    return this.seen.get(id);
  }

  list(): Play[] {
    return this.plays.map((p) => ({ ...p, names: [...p.names] }));
  }

  /** Writes what changed since the last save. */
  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const saved: Saved = { plays: this.plays, seen: Object.fromEntries(this.seen) };
      fs.writeFileSync(tmp, JSON.stringify(saved));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn(`couldn't save ${this.file}: ${(e as Error).message}`);
    }
  }

  private set(id: string, state: WatchState): void {
    this.seen.set(id, state);
    this.dirty = true;
  }
}

/** Everyone who was there, once each (Jake on his TV and his phone is one Jake). */
function merge(names: string[], more: string[]): string[] {
  const out = [...names];
  for (const n of more) if (!out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  return out;
}

function isPlay(p: unknown): p is Play {
  const o = p as Play;
  return !!o && typeof o.id === "string" && typeof o.mediaId === "string" && typeof o.startedAt === "number" && typeof o.lastAt === "number" &&
    typeof o.position === "number" && Array.isArray(o.names) && typeof o.solo === "boolean" && typeof o.watched === "boolean";
}

function isState(s: unknown): s is WatchState {
  const o = s as WatchState;
  return !!o && (o.watchedAt === null || typeof o.watchedAt === "number") && (o.position === null || typeof o.position === "number") && typeof o.updatedAt === "number";
}
