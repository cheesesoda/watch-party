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
import { expectedPosition } from "../../shared/protocol.ts";

export type Send = (msg: ServerMessage) => void;
export type Close = () => void;
export type LookupMedia = (id: string) => MediaItem | undefined;
export type Clock = () => number;

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
  ended = false;
  readonly chat: ChatMessage[] = [];
  emptySince: number;
  /** A binge: media ids played one after another. Empty for a single video. */
  queue: string[] = [];
  /** Counting down to the next video in the binge. */
  private advance: { mediaId: string; at: number; timer: NodeJS.Timeout } | null = null;
  /** How long everyone sees "Up next" before the next video starts. */
  advanceDelayMs = 10_000;

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
    };
  }

  /** The binge as clients see it, with each video's current details; null for a single video. */
  queueInfo(): Queue | null {
    if (this.queue.length < 2) return null;
    const items = this.queue.map((id) => this.lookup(id)).filter((m): m is MediaItem => !!m);
    return { items, advance: this.advance && { mediaId: this.advance.mediaId, at: this.advance.at } };
  }

  /** Sets up a binge and points the room at its first video. Unknown ids are skipped. */
  setQueue(mediaIds: string[]): boolean {
    const ids = [...new Set(mediaIds)].slice(0, MAX_QUEUE).filter((id) => this.lookup(id));
    if (ids.length === 0) return false;
    this.cancelAdvance();
    this.queue = ids.length > 1 ? ids : [];
    return this.select(ids[0]);
  }

  memberList(): Member[] {
    return [...this.members.values()].map((m) => m.member);
  }

  /** `guest` members joined with the party code: they can watch, chat and talk, but not change the video or end the party. */
  join(name: string, send: Send, device: Device = "web", close: Close = () => {}, guest = false): Member {
    const member: Member = { id: crypto.randomUUID(), name: cleanName(name), voice: false, muted: true, device };
    // Someone joining on a second device (say, a phone next to their TV) isn't news to the room.
    const alreadyHere = this.hasName(member.name);
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
    });
    this.broadcast({ type: "members", members: this.memberList() });
    if (!alreadyHere) this.notice(`${member.name} joined`);
    return member;
  }

  leave(memberId: string): void {
    const entry = this.members.get(memberId);
    if (!entry) return;
    this.members.delete(memberId);
    if (this.members.size === 0) this.emptySince = this.now();
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
    this.cancelAdvance();
    // Picking something outside the binge ends it.
    if (!this.queue.includes(mediaId)) this.queue = [];
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
        this.end(member.name);
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
        // Every screen reports the end; the first report for the current video starts the countdown.
        if (msg.mediaId !== this.state.mediaId || this.advance) return;
        const next = this.queue[this.queue.indexOf(msg.mediaId) + 1];
        if (!next || !this.lookup(next)) return;
        const at = now + this.advanceDelayMs;
        this.advance = { mediaId: next, at, timer: setTimeout(() => this.moveOn(next), this.advanceDelayMs) };
        this.advance.timer.unref?.();
        this.broadcastQueue();
        return;
      }

      case "cancel-advance": {
        if (guest) return send({ type: "error", message: "Only the host can change the video." });
        if (!this.advance) return;
        this.cancelAdvance();
        this.broadcastQueue();
        this.notice(`${member.name} stopped the binge from moving on`);
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
        const wasPaused = this.state.paused;
        const paused = msg.type === "seek" ? this.state.paused : msg.type === "pause";
        this.state = { mediaId: this.state.mediaId, paused, position: msg.position, updatedAt: sentAt(msg.at, now) };
        this.broadcastState(member.name);
        if (msg.type === "seek") this.notice(`${member.name} jumped to ${fmtTime(msg.position)}`);
        else if (wasPaused !== paused) this.notice(`${member.name} ${paused ? "paused" : "resumed"} at ${fmtTime(msg.position)}`);
        return;
      }

      default:
        send({ type: "error", message: "Unknown message type." });
    }
  }

  /** Tells everyone the party is over, disconnects them, and removes the room. */
  end(by: string): void {
    if (this.ended) return;
    this.ended = true;
    this.cancelAdvance();
    this.broadcast({ type: "ended", by });
    for (const { close } of [...this.members.values()]) close();
    this.onEnded();
  }

  /** Current position, for display and for late joiners. */
  position(): number {
    return expectedPosition(this.state, this.now());
  }

  /** The countdown ran out: the next video in the binge starts playing for everyone. */
  private moveOn(mediaId: string): void {
    this.advance = null;
    if (this.ended || !this.select(mediaId)) return;
    this.state = { ...this.state, paused: false, updatedAt: this.now() };
    this.broadcastState(null);
    this.broadcastQueue();
    this.notice(`Now playing ${this.media!.title}`);
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

  constructor(
    private lookup: LookupMedia,
    private now: Clock = Date.now,
    private idleMs = 30 * 60_000,
    private iceServers: IceServer[] = DEFAULT_ICE_SERVERS,
  ) {}

  /** queue: a binge, played in order from its first video (mediaId is then ignored). */
  create(mediaId?: string, queue?: string[]): Room {
    let id: string;
    do {
      id = crypto.randomBytes(4).toString("base64url").replace(/[-_]/g, "x").slice(0, 6).toLowerCase();
    } while (this.rooms.has(id));
    const room = new Room(id, this.lookup, this.now, this.iceServers);
    room.onEnded = () => this.rooms.delete(id);
    if (queue && queue.length > 0) room.setQueue(queue);
    else if (mediaId) room.select(mediaId);
    this.rooms.set(id, room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id.toLowerCase());
  }

  /** Drops rooms that have been empty longer than the idle timeout. */
  sweep(): void {
    const now = this.now();
    for (const [id, room] of this.rooms) {
      if (room.members.size === 0 && now - room.emptySince > this.idleMs) this.rooms.delete(id);
    }
  }

  list(): RoomSummary[] {
    return [...this.rooms.values()].map((r) => r.summary());
  }
}
