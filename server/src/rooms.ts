import crypto from "node:crypto";
import type {
  ChatMessage,
  ClientMessage,
  MediaItem,
  Member,
  PlaybackState,
  RoomSummary,
  ServerMessage,
} from "../../shared/protocol.ts";
import { expectedPosition } from "../../shared/protocol.ts";

export type Send = (msg: ServerMessage) => void;
export type LookupMedia = (id: string) => MediaItem | undefined;
export type Clock = () => number;

const CHAT_HISTORY = 100;
const MAX_CHAT_LENGTH = 500;
const MAX_NAME_LENGTH = 32;

function fmtTime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
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
  readonly members = new Map<string, { member: Member; send: Send }>();
  readonly chat: ChatMessage[] = [];
  emptySince: number;

  constructor(
    readonly id: string,
    private lookup: LookupMedia,
    private now: Clock = Date.now,
  ) {
    this.state = { mediaId: null, paused: true, position: 0, updatedAt: now() };
    this.emptySince = now();
  }

  summary(): RoomSummary {
    return { id: this.id, media: this.media, members: this.memberList() };
  }

  memberList(): Member[] {
    return [...this.members.values()].map((m) => m.member);
  }

  join(name: string, send: Send): Member {
    const member: Member = { id: crypto.randomUUID(), name: cleanName(name) };
    this.members.set(member.id, { member, send });
    send({
      type: "welcome",
      you: member,
      roomId: this.id,
      state: this.state,
      media: this.media,
      members: this.memberList(),
      chat: this.chat,
      serverTime: this.now(),
    });
    this.broadcast({ type: "members", members: this.memberList() });
    this.notice(`${member.name} joined`);
    return member;
  }

  leave(memberId: string): void {
    const entry = this.members.get(memberId);
    if (!entry) return;
    this.members.delete(memberId);
    if (this.members.size === 0) this.emptySince = this.now();
    this.broadcast({ type: "members", members: this.memberList() });
    this.notice(`${entry.member.name} left`);
  }

  /** Points the room at a media item without anyone being connected (used when a room is created). */
  select(mediaId: string): boolean {
    const media = this.lookup(mediaId);
    if (!media) return false;
    this.media = media;
    this.state = { mediaId, paused: true, position: 0, updatedAt: this.now() };
    return true;
  }

  handle(memberId: string, msg: ClientMessage): void {
    const entry = this.members.get(memberId);
    if (!entry) return;
    const { member, send } = entry;
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

      case "select": {
        if (typeof msg.mediaId !== "string" || !this.select(msg.mediaId)) {
          send({ type: "error", message: "That file is not in the library." });
          return;
        }
        this.broadcastState(member.name);
        this.notice(`${member.name} started ${this.media!.title}`);
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
        this.state = { mediaId: this.state.mediaId, paused, position: msg.position, updatedAt: now };
        this.broadcastState(member.name);
        if (msg.type === "seek") this.notice(`${member.name} jumped to ${fmtTime(msg.position)}`);
        else if (wasPaused !== paused) this.notice(`${member.name} ${paused ? "paused" : "resumed"} at ${fmtTime(msg.position)}`);
        return;
      }

      default:
        send({ type: "error", message: "Unknown message type." });
    }
  }

  /** Current position, for display and for late joiners. */
  position(): number {
    return expectedPosition(this.state, this.now());
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
  ) {}

  create(mediaId?: string): Room {
    let id: string;
    do {
      id = crypto.randomBytes(4).toString("base64url").replace(/[-_]/g, "x").slice(0, 6).toLowerCase();
    } while (this.rooms.has(id));
    const room = new Room(id, this.lookup, this.now);
    if (mediaId) room.select(mediaId);
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
