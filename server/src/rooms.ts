import crypto from "node:crypto";
import type {
  ChatMessage,
  ClientMessage,
  Device,
  IceServer,
  MediaItem,
  Member,
  PlaybackState,
  Queue,
  RoomSummary,
  ServerMessage,
  SignalData,
} from "../../shared/protocol.ts";
import { expectedPosition, nearEnd, worthSaving } from "../../shared/protocol.ts";
import { History } from "./history.ts";
import { Spots, type SavedSpot } from "./spots.ts";

export type Send = (msg: ServerMessage) => void;
export type Close = () => void;
export type LookupMedia = (id: string) => MediaItem | undefined;
export type Clock = () => number;
/** Where a party stopped: the video to pick up, how far in (seconds), and what was lined up after it. */
export type RoomSpot = { mediaId: string; position: number; next: string[] };

const CHAT_HISTORY = 100;
const MAX_CHAT_LENGTH = 500;
const MAX_NAME_LENGTH = 32;
const MAX_SIGNAL_LENGTH = 12_000;
/** A whole long show is a few hundred episodes. */
export const MAX_QUEUE = 1000;

export const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];

/** Accepts an offer/answer or ICE candidate shaped object; anything else is dropped. */
function validSignal(data: unknown): data is SignalData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, any>;
  if (JSON.stringify(d).length > MAX_SIGNAL_LENGTH) return false;
  if (d.sdp) return (d.sdp.type === "offer" || d.sdp.type === "answer") && typeof d.sdp.sdp === "string";
  if (d.candidate) return typeof d.candidate.candidate === "string";
  return false;
}

function fmtTime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** How far back a sender's own timestamp is believed; anything older or in the future is a clock that's off. */
const MAX_SEND_LAG_MS = 2000;

/**
 * When a play, pause or seek happened, on the server's clock: the sender's own time for it when that's
 * believable, since it was already playing from there while the message was on its way.
 */
export function sentAt(at: unknown, now: number): number {
  return typeof at === "number" && Number.isFinite(at) && at <= now && at >= now - MAX_SEND_LAG_MS ? at : now;
}

function validPosition(p: unknown): p is number {
  return typeof p === "number" && Number.isFinite(p) && p >= 0;
}

export function cleanName(name: unknown): string {
  const s = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
  return s || "Guest";
}

export class Room {
  state: PlaybackState;
  media: MediaItem | null = null;
  readonly members = new Map<string, { member: Member; send: Send; close: Close; guest: boolean }>();
  /** Secret half of the viewer pass handed out for this party's join code; dies with the room. */
  readonly guestKey = crypto.randomBytes(18).toString("base64url");
  /** Set by the RoomManager so ending a party also removes it from the list. */
  onEnded: () => void = () => {};
  /** Set by the RoomManager: keeps where the party stopped, for "Pick up where you left off". */
  onSave: (spot: RoomSpot) => void = () => {};
  /** Set by the RoomManager: notes how far the video got (History) before it changes or the party ends. */
  beforeChange: () => void = () => {};
  ended = false;
  readonly chat: ChatMessage[] = [];
  emptySince: number;
  /** Where the video was when the last person left; a "playing" party keeps counting with nobody watching. */
  private emptyAt: number | null = null;
  /** A binge: media ids played one after another. Empty for a single video. */
  queue: string[] = [];
  /** Counting down to the next video in the binge. */
  private advance: { mediaId: string; at: number; timer: NodeJS.Timeout } | null = null;
  /** How long everyone sees "Up next" before the next video starts. */
  advanceDelayMs = 10_000;
  /** After a jump, the longest everyone waits for slower screens to load the new spot before playing anyway. */
  holdMs = 4_000;
  /**
   * When no screen has loaded the spot by then (watching alone, or every screen slow), there's nobody to start without:
   * the wait goes on until the first one has, up to this long.
   */
  holdMaxMs = 30_000;
  /**
   * Watching alone, how long the party plays on after its screen goes before pausing where it went: a dropped
   * connection comes back by itself (the apps reconnect), and shouldn't find the video paused.
   */
  soloGraceMs = 30_000;
  private emptyTimer: NodeJS.Timeout | null = null;
  /** Waiting for screens to load the spot someone jumped to: who has, and whether holdMs has run out. */
  private hold: { ready: Set<string>; timer: NodeJS.Timeout; since: number; overdue?: boolean } | null = null;
  /** Screens the last hold gave up waiting for, so the log can say when each caught up. */
  private late: { ids: Set<string>; since: number; gaveUpAt: number } | null = null;
  /** Members whose screen plays the video and says when it has loaded a spot (newer apps only). */
  private players = new Set<string>();
  /** The host watching alone: guests can't join with its code, and it isn't on the party list, until "invite". */
  solo = false;
  /** Watching alone starts playing by itself once the host's screen is in (a party waits for the host to press play). */
  autoplay = false;
  /** Where jump waits are noted, so the server log shows who was waited for and how long. */
  log: (line: string) => void = (line) => console.log(`party ${this.id}: ${line}`);

  constructor(
    readonly id: string,
    private lookup: LookupMedia,
    private now: Clock = Date.now,
    private iceServers: IceServer[] = DEFAULT_ICE_SERVERS,
  ) {
    this.state = { mediaId: null, paused: true, position: 0, updatedAt: now() };
    this.emptySince = now();
  }

  summary(): RoomSummary {
    const index = this.media ? this.queue.indexOf(this.media.id) : -1;
    return {
      id: this.id,
      media: this.media,
      members: this.memberList(),
      binge: this.queue.length > 1 && index >= 0 ? { index: index + 1, length: this.queue.length } : null,
      upNext: this.upNextInfo(),
      solo: this.solo,
    };
  }

  /** The videos after the one playing now. */
  private upcoming(): string[] {
    const index = this.media ? this.queue.indexOf(this.media.id) : -1;
    return index >= 0 ? this.queue.slice(index + 1) : [];
  }

  private upNextInfo(): RoomSummary["upNext"] {
    const ids = this.upcoming();
    const item = ids.length > 0 ? this.lookup(ids[0]) : undefined;
    return item ? { item, count: ids.length } : null;
  }

  /** The binge as clients see it, with each video's current details; null for a single video. */
  queueInfo(): Queue | null {
    if (this.queue.length < 2) return null;
    const items = this.queue.map((id) => this.lookup(id)).filter((m): m is MediaItem => !!m);
    const at = this.media ? items.findIndex((m) => m.id === this.media!.id) : -1;
    return { items, at, advance: this.advance && { mediaId: this.advance.mediaId, at: this.advance.at } };
  }

  /** Sets up a binge and points the room at its first video. Unknown ids are skipped. */
  setQueue(mediaIds: string[]): boolean {
    const ids = [...new Set(mediaIds)].slice(0, MAX_QUEUE).filter((id) => this.lookup(id));
    if (ids.length === 0) return false;
    this.cancelAdvance();
    this.queue = ids.length > 1 ? ids : [];
    return this.select(ids[0]);
  }

  /** Adds videos to the end of Up next. One already there moves to the end; one played earlier comes back. */
  addToQueue(mediaIds: string[]): string[] {
    const ids = [...new Set(mediaIds)].filter((id) => id !== this.media?.id && this.lookup(id));
    if (ids.length === 0) return [];
    if (!this.media) {
      this.setQueue(ids);
      return ids;
    }
    const base = this.queue.length > 0 ? this.queue : [this.media.id];
    this.queue = [...base.filter((id) => !ids.includes(id)), ...ids].slice(-MAX_QUEUE);
    if (!this.queue.includes(this.media.id)) this.queue.unshift(this.media.id);
    this.queueChanged();
    return ids;
  }

  /** Takes a video out of Up next. False if it isn't coming up. */
  removeFromQueue(mediaId: string): boolean {
    if (!this.upcoming().includes(mediaId)) return false;
    this.queue = this.queue.filter((id) => id !== mediaId);
    this.queueChanged();
    return true;
  }

  /** Moves a video to place [to] in Up next (0 = next). False if it isn't coming up. */
  moveInQueue(mediaId: string, to: number): boolean {
    const upcoming = this.upcoming();
    if (!upcoming.includes(mediaId) || !Number.isInteger(to)) return false;
    const rest = upcoming.filter((id) => id !== mediaId);
    rest.splice(Math.max(0, Math.min(to, rest.length)), 0, mediaId);
    this.queue = [...this.queue.slice(0, this.queue.length - upcoming.length), ...rest];
    this.queueChanged();
    return true;
  }

  /** Empties Up next; the video playing now (and the ones before it, for Previous) stay. */
  clearQueue(): void {
    const upcoming = this.upcoming().length;
    if (upcoming > 0) this.queue = this.queue.slice(0, this.queue.length - upcoming);
    this.queueChanged();
  }

  /** After an edit: a single video isn't a queue, and a countdown to a video that's no longer next stops. */
  private queueChanged(): void {
    if (this.queue.length < 2) this.queue = [];
    if (this.advance && this.advance.mediaId !== this.upcoming()[0]) this.cancelAdvance();
  }

  memberList(): Member[] {
    return [...this.members.values()].map((m) => m.member);
  }

  /** `guest` members joined with the party code: they can watch, chat and talk, but not change the video or end the party. */
  join(name: string, send: Send, device: Device = "web", close: Close = () => {}, guest = false): Member {
    const member: Member = { id: crypto.randomUUID(), name: cleanName(name), voice: false, muted: true, device };
    // Someone joining on a second device (say, a phone next to their TV) isn't news to the room.
    const alreadyHere = this.hasName(member.name);
    this.emptyAt = null;
    this.cancelEmpty();
    this.members.set(member.id, { member, send, close, guest });
    send({
      type: "welcome",
      you: member,
      roomId: this.id,
      state: this.state,
      media: this.media,
      members: this.memberList(),
      chat: this.chat,
      serverTime: this.now(),
      iceServers: this.iceServers,
      queue: this.queueInfo(),
      solo: this.solo,
    });
    this.broadcast({ type: "members", members: this.memberList() });
    if (!alreadyHere) this.notice(`${member.name} joined`);
    return member;
  }

  /** [lost] says why a connection dropped (rather than closed), for the log. */
  leave(memberId: string, lost: string | null = null): void {
    const entry = this.members.get(memberId);
    if (!entry) return;
    if (lost && !this.ended) this.log(`${this.who([memberId])} lost connection (${lost})`);
    this.members.delete(memberId);
    this.players.delete(memberId);
    if (this.members.size === 0) {
      this.emptySince = this.now();
      this.emptyAt = this.position();
      // Watching alone with nobody left watching: pause where they left, unless their screen is back by then.
      if (this.solo && !this.state.paused && !this.ended) {
        const at = this.emptyAt;
        this.emptyTimer = setTimeout(() => {
          this.emptyTimer = null;
          if (this.members.size > 0 || this.state.paused || this.ended) return;
          this.cancelHold();
          this.state = { mediaId: this.state.mediaId, paused: true, position: at, updatedAt: this.now() };
          this.log(`paused at ${fmtTime(at)}: nobody is watching`);
        }, this.soloGraceMs);
      }
    }
    this.resumeIfAllReady();
    if (this.ended) return;
    this.broadcast({ type: "members", members: this.memberList() });
    if (!this.hasName(entry.member.name)) this.notice(`${entry.member.name} left`);
  }

  private hasName(name: string): boolean {
    const key = name.toLowerCase();
    return this.memberList().some((m) => m.name.toLowerCase() === key);
  }

  /** Points the room at a media item without anyone being connected (used when a room is created). */
  select(mediaId: string): boolean {
    const media = this.lookup(mediaId);
    if (!media) return false;
    if (this.media) this.beforeChange();
    this.cancelAdvance();
    this.cancelHold();
    if (!this.queue.includes(mediaId)) {
      // Playing something else keeps Up next: it goes in right after the video that was playing, so Previous goes back there.
      const index = this.media ? this.queue.indexOf(this.media.id) : -1;
      this.queue = index >= 0 && index < this.queue.length - 1 ? [...this.queue.slice(0, index + 1), mediaId, ...this.queue.slice(index + 1)] : [];
    }
    this.media = media;
    this.state = { mediaId, paused: true, position: 0, updatedAt: this.now() };
    return true;
  }

  handle(memberId: string, msg: ClientMessage): void {
    const entry = this.members.get(memberId);
    if (!entry) return;
    const { member, send, guest } = entry;
    const now = this.now();

    switch (msg.type) {
      case "ping":
        send({ type: "pong", clientTime: Number(msg.clientTime) || 0, serverTime: now });
        return;

      case "player":
        if (msg.on === true) this.players.add(member.id);
        else this.players.delete(member.id);
        if (msg.on === true && this.autoplay && !guest && this.state.mediaId && this.state.paused) {
          // Watching alone: play as soon as this screen has loaded the video, as a jump does.
          this.autoplay = false;
          this.holdAt(this.state.position, now);
          this.log(`${member.name} is watching alone; waiting for ${this.who(this.players)}`);
          this.broadcastState(null);
          return;
        }
        this.resumeIfAllReady();
        return;

      case "ready": {
        const copy = msg.converted === true ? " (converted copy)" : "";
        if (msg.late === true) {
          if (this.late?.ids.delete(member.id)) {
            this.log(`${this.who([member.id])} caught up ${now - this.late.since} ms after the jump, ${now - this.late.gaveUpAt} ms after the others started${copy}`);
          }
          return;
        }
        if (this.hold && this.state.hold && validPosition(msg.position) && Math.abs(msg.position - this.state.position) < 1) {
          this.players.add(member.id);
          this.hold.ready.add(member.id);
          this.log(`${this.who([member.id])} loaded it after ${now - this.hold.since} ms${copy}`);
          if (this.hold.overdue) this.resumeHold();
          else this.resumeIfAllReady();
        }
        return;
      }

      case "chat": {
        const text = typeof msg.text === "string" ? msg.text.trim().slice(0, MAX_CHAT_LENGTH) : "";
        if (!text) return;
        this.pushChat({ id: crypto.randomUUID(), from: member.name, text, ts: now });
        return;
      }

      case "voice": {
        const on = msg.on === true;
        const wasOn = member.voice;
        member.voice = on;
        member.muted = !on || msg.muted !== false;
        if (on && !wasOn) {
          const peers = this.memberList().filter((m) => m.voice && m.id !== member.id).map((m) => m.id);
          send({ type: "voice-peers", peers });
        }
        this.broadcast({ type: "members", members: this.memberList() });
        if (on !== wasOn) this.notice(`${member.name} ${on ? "joined" : "left"} voice`);
        return;
      }

      case "signal": {
        const target = typeof msg.to === "string" ? this.members.get(msg.to) : undefined;
        if (!member.voice || !target?.member.voice || !validSignal(msg.data)) return;
        target.send({ type: "signal", from: member.id, data: msg.data });
        return;
      }

      case "end":
        if (guest) return send({ type: "error", message: "Only the host can end the party." });
        this.end(member.name, msg.save === true);
        return;

      case "invite":
        if (guest || !this.solo) return;
        this.solo = false;
        this.broadcast({ type: "solo", solo: false });
        return;

      case "select": {
        if (guest) return send({ type: "error", message: "Only the host can change the video." });
        if (typeof msg.mediaId !== "string" || !this.select(msg.mediaId)) {
          send({ type: "error", message: "That file is not in the library." });
          return;
        }
        // Moving around a binge keeps it playing, like a TV remote's next button.
        if (this.queue.length > 0) this.state = { ...this.state, paused: false };
        this.broadcastState(member.name);
        this.broadcastQueue();
        this.notice(`${member.name} started ${this.media!.title}`);
        return;
      }

      case "binge": {
        if (guest) return send({ type: "error", message: "Only the host can change the video." });
        const ids = Array.isArray(msg.mediaIds) ? msg.mediaIds.filter((id): id is string => typeof id === "string") : [];
        if (!this.setQueue(ids)) return send({ type: "error", message: "Those files are not in the library." });
        this.broadcastState(member.name);
        this.broadcastQueue();
        const count = this.queue.length;
        this.notice(count > 1 ? `${member.name} started a binge of ${count} videos with ${this.media!.title}` : `${member.name} started ${this.media!.title}`);
        return;
      }

      case "ended": {
        // Every screen reports the end (or the credits starting); the first report for the current video starts the countdown.
        if (msg.mediaId !== this.state.mediaId || this.advance) return;
        const next = this.queue[this.queue.indexOf(msg.mediaId) + 1];
        if (!next || !this.lookup(next)) return;
        const at = now + this.advanceDelayMs;
        this.advance = { mediaId: next, at, timer: setTimeout(() => this.moveOn(next), this.advanceDelayMs) };
        this.advance.timer.unref?.();
        this.broadcastQueue();
        return;
      }

      // Anyone can Stay here or Play now on the Up next card, as anyone can skip an intro.
      case "cancel-advance": {
        if (!this.advance) return;
        this.cancelAdvance();
        this.broadcastQueue();
        this.notice(`${member.name} stopped the binge from moving on`);
        return;
      }

      case "advance-now": {
        if (!this.advance) return;
        this.moveOn(this.advance.mediaId);
        return;
      }

      case "queue-add": {
        if (guest) return send({ type: "error", message: "Only the host can change Up next." });
        const hadMedia = !!this.media;
        const ids = this.addToQueue(Array.isArray(msg.mediaIds) ? msg.mediaIds.filter((id): id is string => typeof id === "string").slice(0, MAX_QUEUE) : []);
        if (ids.length === 0) return;
        if (!hadMedia) this.broadcastState(member.name);
        this.broadcastQueue();
        const first = this.lookup(ids[0])!;
        this.notice(`${member.name} added ${ids.length > 1 ? `${ids.length} videos` : first.title} to Up next`);
        return;
      }

      case "queue-remove":
      case "queue-move":
      case "queue-clear": {
        if (guest) return send({ type: "error", message: "Only the host can change Up next." });
        if (msg.type === "queue-clear") this.clearQueue();
        else if (msg.type === "queue-remove" ? !this.removeFromQueue(String(msg.mediaId)) : !this.moveInQueue(String(msg.mediaId), Number(msg.to))) return;
        this.broadcastQueue();
        return;
      }

      case "play":
      case "pause":
      case "seek": {
        if (!this.state.mediaId) return;
        if (!validPosition(msg.position)) {
          send({ type: "error", message: "Invalid position." });
          return;
        }
        const wasPaused = this.state.paused && !this.state.hold;
        const paused = msg.type === "seek" ? wasPaused : msg.type === "pause";
        this.cancelHold();
        if (msg.type === "seek" && !paused && this.players.size > 0) {
          // Jumping while playing: everyone pauses at the new spot until each screen has loaded it.
          this.holdAt(msg.position, now);
          this.log(`${this.who([member.id])} jumped to ${fmtTime(msg.position)}; waiting for ${this.who(this.players) || "nobody"}`);
        } else {
          this.state = { mediaId: this.state.mediaId, paused, position: msg.position, updatedAt: sentAt(msg.at, now) };
          if (msg.type === "seek") this.log(`${this.who([member.id])} jumped to ${fmtTime(msg.position)}; no wait (${paused ? "paused" : "no screens say when they've loaded"})`);
          else if (wasPaused !== paused) this.log(`${this.who([member.id])} ${paused ? "paused" : "pressed play"} at ${fmtTime(msg.position)}`);
          else if (!paused) this.log(`${this.who([member.id])} played from ${fmtTime(msg.position)} (already playing)`);
        }
        this.broadcastState(member.name);
        if (msg.type === "seek" && (msg.skip === "intro" || msg.skip === "recap")) this.notice(`${member.name} skipped the ${msg.skip}`);
        else if (msg.type === "seek") this.notice(`${member.name} jumped to ${fmtTime(msg.position)}`);
        else if (wasPaused !== paused) this.notice(`${member.name} ${paused ? "paused" : "resumed"} at ${fmtTime(msg.position)}`);
        return;
      }

      default:
        send({ type: "error", message: "Unknown message type." });
    }
  }

  /** Tells everyone the party is over, disconnects them, and removes the room. */
  /** `save`: keep where the party is (see [spot]) so a new party can pick up there. */
  end(by: string, save = false): void {
    if (this.ended) return;
    this.beforeChange();
    const spot = save ? this.spot() : null;
    if (spot) this.onSave(spot);
    this.ended = true;
    this.cancelAdvance();
    this.cancelHold();
    this.cancelEmpty();
    this.broadcast({ type: "ended", by });
    for (const { close } of [...this.members.values()]) close();
    this.onEnded();
  }

  /**
   * Where a new party would pick up: this video and spot, or the next one if this one is at its credits, with
   * the rest of Up next. Null when there's nothing worth coming back to (see worthSaving).
   */
  spot(): RoomSpot | null {
    if (!this.media) return null;
    const next = this.upcoming();
    const position = this.members.size === 0 && this.emptyAt !== null ? this.emptyAt : this.position();
    const credits = this.media.marks?.credits;
    if (!worthSaving(position, this.media.duration, next.length, credits)) return null;
    if (nearEnd(position, this.media.duration, credits)) return { mediaId: next[0], position: 0, next: next.slice(1) };
    return { mediaId: this.media.id, position, next };
  }

  /** Current position, for display and for late joiners. */
  position(): number {
    return expectedPosition(this.state, this.now());
  }

  /** The countdown ran out: the next video in the binge starts playing for everyone. */
  private moveOn(mediaId: string): void {
    this.cancelAdvance();
    if (this.ended || !this.select(mediaId)) return;
    this.state = { ...this.state, paused: false, updatedAt: this.now() };
    this.broadcastState(null);
    this.broadcastQueue();
    this.notice(`Now playing ${this.media!.title}`);
  }

  /** Pauses everyone at [position] until each screen has loaded it (or [holdMs] runs out), then plays. */
  private holdAt(position: number, now: number): void {
    this.state = { mediaId: this.state.mediaId, paused: true, position, updatedAt: now, hold: true };
    this.late = null;
    const timer = setTimeout(() => this.holdRanOut(), this.holdMs);
    timer.unref?.();
    this.hold = { ready: new Set(), timer, since: now };
  }

  /** holdMs is up: play without the slower screens, unless none has loaded the spot yet. */
  private holdRanOut(): void {
    if (!this.hold) return;
    const left = this.holdMaxMs - (this.now() - this.hold.since);
    const anyReady = [...this.hold.ready].some((id) => this.members.has(id));
    const waiting = [...this.players].some((id) => this.members.has(id));
    if (anyReady || !waiting || left <= 0) return this.resumeHold();
    this.hold.overdue = true;
    this.hold.timer = setTimeout(() => this.resumeHold(), left);
    this.hold.timer.unref?.();
    this.log(`no screen has loaded it after ${this.now() - this.hold.since} ms; waiting for the first one`);
  }

  /** Everyone has loaded the spot (or the wait ran out): play from it together. */
  private resumeHold(): void {
    if (!this.hold) return;
    const { ready, since } = this.hold;
    this.cancelHold();
    if (this.ended || !this.state.hold) return;
    const late = [...this.players].filter((id) => this.members.has(id) && !ready.has(id));
    this.log(`playing after ${this.now() - since} ms${late.length ? `; gave up waiting for ${this.who(late)}` : ""}`);
    this.late = late.length ? { ids: new Set(late), since, gaveUpAt: this.now() } : null;
    this.state = { mediaId: this.state.mediaId, paused: false, position: this.state.position, updatedAt: this.now() };
    this.broadcastState(null);
  }

  /** Names and devices, like "Jake (tv), Jake (web)". */
  private who(ids: Iterable<string>): string {
    return [...ids].map((id) => this.members.get(id)?.member).filter((m) => m).map((m) => `${m!.name} (${m!.device})`).join(", ");
  }

  private resumeIfAllReady(): void {
    if (!this.hold) return;
    const waiting = [...this.players].some((id) => this.members.has(id) && !this.hold!.ready.has(id));
    if (!waiting) this.resumeHold();
  }

  private cancelHold(): void {
    if (this.hold) clearTimeout(this.hold.timer);
    this.hold = null;
  }

  private cancelEmpty(): void {
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
  }

  private cancelAdvance(): void {
    if (this.advance) clearTimeout(this.advance.timer);
    this.advance = null;
  }

  private broadcastQueue(): void {
    this.broadcast({ type: "queue", queue: this.queueInfo() });
  }

  private broadcastState(by: string | null): void {
    this.broadcast({ type: "state", state: this.state, media: this.media, by });
  }

  private notice(text: string): void {
    this.pushChat({ id: crypto.randomUUID(), from: "", text, ts: this.now(), system: true });
  }

  private pushChat(message: ChatMessage): void {
    this.chat.push(message);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.broadcast({ type: "chat", message });
  }

  private broadcast(msg: ServerMessage): void {
    for (const { send } of this.members.values()) send(msg);
  }
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  /** When a party last ended per show (or movie), so a party left sitting doesn't bring back an older spot. */
  private lastEnded = new Map<string, number>();

  constructor(
    private lookup: LookupMedia,
    private now: Clock = Date.now,
    private idleMs = 30 * 60_000,
    private iceServers: IceServer[] = DEFAULT_ICE_SERVERS,
    readonly spots: Spots = new Spots(undefined, now),
    readonly history: History = new History(undefined, now),
  ) {}

  /**
   * queue: a binge, played in order from its first video (mediaId is then ignored). position: where in the first
   * video to start (picking up a saved spot).
   */
  create(mediaId?: string, queue?: string[], position = 0, solo = false): Room {
    let id: string;
    do {
      id = crypto.randomBytes(4).toString("base64url").replace(/[-_]/g, "x").slice(0, 6).toLowerCase();
    } while (this.rooms.has(id));
    const room = new Room(id, this.lookup, this.now, this.iceServers);
    room.solo = solo;
    room.autoplay = solo;
    room.onEnded = () => {
      this.rooms.delete(id);
      this.spots.ended(id);
      this.history.ended(id);
      this.history.save();
      const key = room.media && this.key(room.media.id);
      if (key) this.lastEnded.set(key, this.now());
    };
    room.onSave = (spot) => this.save(spot);
    room.beforeChange = () => this.track(room);
    if (queue && queue.length > 0) room.setQueue(queue);
    else if (mediaId) room.select(mediaId);
    if (room.media && position > 0) room.state = { ...room.state, position };
    this.rooms.set(id, room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id.toLowerCase());
  }

  /** A party friends can join with its code: not one where the host is watching alone. */
  joinable(id: string): Room | undefined {
    const room = this.get(id);
    return room && !room.solo ? room : undefined;
  }

  /**
   * Drops rooms that have been empty longer than the idle timeout. Nobody is there to ask, so where they stopped
   * is kept, the same as Save spot.
   */
  sweep(): void {
    const now = this.now();
    for (const [id, room] of this.rooms) {
      if (room.members.size === 0 && now - room.emptySince > this.idleMs) {
        this.spots.ended(id);
        this.history.ended(id);
        const spot = room.spot();
        if (spot && !this.watchedSince(room, spot.mediaId)) this.save(spot);
        this.rooms.delete(id);
      }
    }
  }

  /**
   * Whether the show (or movie) was watched in another party after this one was left: its spot would be older than
   * where they got to (say a party stuck when the connection dropped, and the episode finished in a new one).
   */
  private watchedSince(room: Room, mediaId: string): boolean {
    const key = this.key(mediaId);
    if (!key) return false;
    if ((this.lastEnded.get(key) ?? 0) > room.emptySince) return true;
    return [...this.rooms.values()].some((other) => {
      if (other === room || !other.media || this.key(other.media.id) !== key) return false;
      return other.members.size > 0 || other.emptySince > room.emptySince;
    });
  }

  /**
   * Keeps where each party is on disk as it plays, so stopping the server (which ends every party without asking:
   * the tray just ends the process) still leaves a spot to pick up. Home hides it while the party goes on.
   */
  keepSpots(): void {
    for (const [id, room] of this.rooms) {
      const spot = room.spot();
      const key = spot && this.key(spot.mediaId);
      this.spots.live(id, spot && key ? { ...spot, key } : null);
      this.track(room);
    }
    this.history.save();
  }

  /** How far the party's video has got, for watched marks and History. Only while someone is watching. */
  private track(room: Room): void {
    if (!room.media || room.members.size === 0) return;
    this.history.track({
      room: room.id,
      solo: room.solo,
      mediaId: room.media.id,
      position: room.position(),
      paused: room.state.paused,
      duration: room.media.duration,
      credits: room.media.marks?.credits,
      names: room.memberList().map((m) => m.name),
    });
  }

  /** Saved spots, without the ones of parties still playing. */
  savedSpots(): SavedSpot[] {
    return this.spots.list().filter((s) => !s.room || !this.rooms.has(s.room));
  }

  /** One spot per show (or movie): a later one replaces it. */
  private save(spot: RoomSpot): void {
    const key = this.key(spot.mediaId);
    if (key) this.spots.add({ ...spot, key });
  }

  private key(mediaId: string): string | null {
    const media = this.lookup(mediaId);
    if (!media) return null;
    const show = media.episode && (media.meta?.show ?? media.episode.show);
    return show ? `show:${show.toLowerCase()}` : `media:${media.id}`;
  }

  /** The parties, without the host's own solo viewing. */
  parties(): Room[] {
    return [...this.rooms.values()].filter((r) => !r.solo);
  }

  list(): RoomSummary[] {
    return this.parties().map((r) => r.summary());
  }
}
