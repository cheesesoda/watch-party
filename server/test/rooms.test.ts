import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaItem, ServerMessage } from "../../shared/protocol.ts";
import { RoomManager } from "../src/rooms.ts";

const movie: MediaItem = { id: "m1", title: "Movie", relPath: "Movie.mp4", folder: "", size: 1, mime: "video/mp4", subtitles: [] };

function setup() {
  let now = 1_000;
  const clock = { tick: (ms: number) => (now += ms) };
  const mgr = new RoomManager((id) => (id === movie.id ? movie : undefined), () => now, 1000);
  const room = mgr.create(movie.id);
  const inbox = (): ServerMessage[] => [];
  const a: ServerMessage[] = inbox();
  const b: ServerMessage[] = inbox();
  const alice = room.join("  Alice  ", (m) => a.push(m));
  const bob = room.join("", (m) => b.push(m));
  return { mgr, room, a, b, alice, bob, clock };
}

test("join sends welcome with current state and broadcasts members", () => {
  const { a, b, alice, bob } = setup();
  assert.equal(alice.name, "Alice");
  assert.equal(bob.name, "Guest");
  const welcome = b.find((m) => m.type === "welcome");
  assert.ok(welcome && welcome.type === "welcome");
  assert.equal(welcome.media?.id, "m1");
  assert.equal(welcome.state.paused, true);
  const lastMembers = a.filter((m) => m.type === "members").at(-1);
  assert.ok(lastMembers?.type === "members" && lastMembers.members.length === 2);
});

test("play/pause/seek update state for everyone", () => {
  const { room, a, b, alice, bob, clock } = setup();
  room.handle(alice.id, { type: "play", position: 12 });
  const st = b.filter((m) => m.type === "state").at(-1);
  assert.ok(st?.type === "state");
  assert.equal(st.state.paused, false);
  assert.equal(st.state.position, 12);
  assert.equal(st.by, "Alice");

  clock.tick(3000);
  assert.equal(room.position(), 15);

  room.handle(bob.id, { type: "seek", position: 100 });
  assert.equal(room.state.paused, false, "seek keeps play state");
  room.handle(bob.id, { type: "pause", position: 101 });
  assert.equal(room.state.paused, true);
  clock.tick(5000);
  assert.equal(room.position(), 101);
  assert.ok(a.some((m) => m.type === "chat" && m.message.system && m.message.text === "Guest paused at 1:41"));
});

test("rejects bad input", () => {
  const { room, b, bob } = setup();
  room.handle(bob.id, { type: "seek", position: -1 });
  room.handle(bob.id, { type: "seek", position: NaN });
  room.handle(bob.id, { type: "select", mediaId: "nope" });
  assert.equal(b.filter((m) => m.type === "error").length, 3);
  assert.equal(room.state.position, 0);
  assert.equal(room.media?.id, "m1");
});

test("chat is trimmed, capped, and kept in history", () => {
  const { room, a, alice } = setup();
  room.handle(alice.id, { type: "chat", text: "   " });
  room.handle(alice.id, { type: "chat", text: " hi " + "x".repeat(600) });
  const msgs = a.filter((m) => m.type === "chat" && !m.message.system);
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].type === "chat" && msgs[0].message.text.startsWith("hi x") && msgs[0].message.text.length === 500);
  assert.ok(room.chat.some((c) => c.from === "Alice"));
});

test("ping answers with server time", () => {
  const { room, a, alice } = setup();
  room.handle(alice.id, { type: "ping", clientTime: 42 });
  const pong = a.at(-1);
  assert.deepEqual(pong, { type: "pong", clientTime: 42, serverTime: 1000 });
});

test("empty rooms are swept after the idle timeout", () => {
  const { mgr, room, alice, bob, clock } = setup();
  room.leave(alice.id);
  room.leave(bob.id);
  mgr.sweep();
  assert.ok(mgr.get(room.id));
  clock.tick(1001);
  mgr.sweep();
  assert.equal(mgr.get(room.id), undefined);
});

test("joining voice tells the newcomer who to call and relays signals only between voice members", () => {
  const { room, a, b, alice, bob } = setup();
  const offer = { sdp: { type: "offer" as const, sdp: "v=0" } };

  room.handle(alice.id, { type: "voice", on: true, muted: false });
  assert.deepEqual(a.filter((m) => m.type === "voice-peers").at(-1), { type: "voice-peers", peers: [] });

  // Bob is not in voice yet, so nothing reaches him.
  room.handle(alice.id, { type: "signal", to: bob.id, data: offer });
  assert.equal(b.filter((m) => m.type === "signal").length, 0);

  room.handle(bob.id, { type: "voice", on: true, muted: true });
  assert.deepEqual(b.filter((m) => m.type === "voice-peers").at(-1), { type: "voice-peers", peers: [alice.id] });
  const members = a.filter((m) => m.type === "members").at(-1);
  assert.ok(members?.type === "members");
  assert.deepEqual(
    members.members.map((m) => [m.name, m.voice, m.muted]),
    [
      ["Alice", true, false],
      ["Guest", true, true],
    ],
  );

  room.handle(bob.id, { type: "signal", to: alice.id, data: offer });
  assert.deepEqual(a.filter((m) => m.type === "signal").at(-1), { type: "signal", from: bob.id, data: offer });

  // Malformed or oversized payloads are dropped.
  const before = a.length;
  room.handle(bob.id, { type: "signal", to: alice.id, data: { nope: 1 } as any });
  room.handle(bob.id, { type: "signal", to: alice.id, data: { sdp: { type: "offer", sdp: "x".repeat(20_000) } } });
  assert.equal(a.length, before);

  // A mute change does not ask for new connections.
  room.handle(alice.id, { type: "voice", on: true, muted: true });
  assert.equal(a.filter((m) => m.type === "voice-peers").length, 1);

  room.handle(alice.id, { type: "voice", on: false, muted: true });
  assert.ok(a.some((m) => m.type === "chat" && m.message.text === "Alice left voice"));
});

test("a second device under the same name joins quietly", () => {
  const { room, a } = setup();
  const notices = () => a.filter((m) => m.type === "chat" && m.message.system).map((m) => (m.type === "chat" ? m.message.text : ""));
  const before = notices().length;
  const phone = room.join("alice", () => {}, "phone");
  assert.equal(phone.device, "phone");
  assert.equal(notices().length, before);
  room.leave(phone.id);
  assert.equal(notices().length, before);
  const members = a.filter((m) => m.type === "members").at(-1);
  assert.ok(members?.type === "members" && members.members.every((m) => m.device === "web"));
});

test("ending a party tells everyone, disconnects them and removes the room", () => {
  const { mgr, room, a, b, alice } = setup();
  let closed = 0;
  room.join("Cat", () => {}, "web", () => closed++);
  room.handle(alice.id, { type: "end" });
  assert.deepEqual(a.at(-1), { type: "ended", by: "Alice" });
  assert.deepEqual(b.at(-1), { type: "ended", by: "Alice" });
  assert.equal(closed, 1);
  assert.equal(mgr.get(room.id), undefined);
  // Late leave events from the closing sockets don't post "left" notices.
  const before = a.length;
  room.leave(alice.id);
  assert.equal(a.length, before);
});
