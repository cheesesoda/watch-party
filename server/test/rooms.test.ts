import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaItem, ServerMessage } from "../../shared/protocol.ts";
import { RoomManager, sentAt } from "../src/rooms.ts";

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

test("a binge plays its videos in order, moving on after a countdown the host can cancel", async () => {
  const eps: MediaItem[] = [1, 2, 3].map((n) => ({ ...movie, id: `e${n}`, title: `Show S1 E${n}` }));
  const mgr = new RoomManager((id) => eps.find((e) => e.id === id), Date.now, 1000);
  const room = mgr.create(undefined, ["e1", "nope", "e2", "e3"]);
  room.advanceDelayMs = 5;
  assert.equal(room.media?.id, "e1");
  assert.deepEqual(room.summary().binge, { index: 1, length: 3 });

  const inbox: ServerMessage[] = [];
  const host = room.join("Host", (m) => inbox.push(m));
  const viewer = room.join("Viewer", () => {}, "web", () => {}, true);
  const welcome = inbox.find((m) => m.type === "welcome");
  assert.ok(welcome?.type === "welcome");
  assert.deepEqual(welcome.queue?.items.map((i) => i.id), ["e1", "e2", "e3"]);

  // Both screens report the end; one countdown starts.
  room.handle(viewer.id, { type: "ended", mediaId: "e1" });
  room.handle(host.id, { type: "ended", mediaId: "e1" });
  const counting = inbox.filter((m) => m.type === "queue").at(-1);
  assert.ok(counting?.type === "queue");
  assert.equal(counting.queue?.advance?.mediaId, "e2");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(room.media?.id, "e2");
  assert.equal(room.state.paused, false, "the next one starts playing");

  // Anyone can stay (a guest too, as anyone can skip an intro).
  room.handle(host.id, { type: "ended", mediaId: "e2" });
  room.handle(viewer.id, { type: "cancel-advance" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(room.media?.id, "e2");
  assert.ok(room.chat.at(-1)?.text.includes("Viewer stopped the binge from moving on"));

  // ...or play the next one now, without waiting out the countdown.
  room.advanceDelayMs = 60_000;
  room.handle(host.id, { type: "ended", mediaId: "e2" });
  room.handle(viewer.id, { type: "advance-now" });
  assert.equal(room.media?.id, "e3");
  assert.equal(room.state.paused, false);
  assert.equal(room.queueInfo()?.advance, null);
  room.handle(viewer.id, { type: "advance-now" });
  assert.equal(room.media?.id, "e3", "nothing happens with no countdown");
  room.advanceDelayMs = 5;

  // Going back within the binge keeps it; picking another video ends it.
  room.handle(host.id, { type: "select", mediaId: "e1" });
  assert.deepEqual(room.summary().binge, { index: 1, length: 3 });
  room.handle(host.id, { type: "binge", mediaIds: ["e3", "e2"] });
  assert.equal(room.media?.id, "e3");
  room.handle(host.id, { type: "ended", mediaId: "e2" });
  assert.equal(room.queueInfo()?.advance, null, "only the video playing now counts");
  mgr.rooms.clear();
});

test("the host adds to, reorders, trims and clears Up next; guests can't", () => {
  const vids: MediaItem[] = [1, 2, 3, 4, 5].map((n) => ({ ...movie, id: `v${n}`, title: `Video ${n}` }));
  const mgr = new RoomManager((id) => vids.find((v) => v.id === id), Date.now, 1000);
  const room = mgr.create("v1");
  const inbox: ServerMessage[] = [];
  const host = room.join("Host", (m) => inbox.push(m));
  const guest = room.join("Guest", () => {}, "web", () => {}, true);
  const ids = () => room.queueInfo()?.items.map((i) => i.id) ?? [];

  room.handle(guest.id, { type: "queue-add", mediaIds: ["v2"] });
  assert.equal(room.queueInfo(), null, "a guest can't add");

  room.handle(host.id, { type: "queue-add", mediaIds: ["v2", "v3", "v1", "nope"] });
  assert.deepEqual(ids(), ["v1", "v2", "v3"], "the video playing now and unknown ids are skipped");
  assert.equal(room.queueInfo()?.at, 0);
  assert.deepEqual(room.summary().upNext, { item: vids[1], count: 2 });
  assert.ok(room.chat.at(-1)?.text.includes("added 2 videos to Up next"));

  room.handle(host.id, { type: "queue-add", mediaIds: ["v4"] });
  room.handle(host.id, { type: "queue-move", mediaId: "v4", to: 0 });
  assert.deepEqual(ids(), ["v1", "v4", "v2", "v3"]);
  room.handle(host.id, { type: "queue-move", mediaId: "v4", to: 99 });
  assert.deepEqual(ids(), ["v1", "v2", "v3", "v4"]);
  room.handle(host.id, { type: "queue-move", mediaId: "v1", to: 2 });
  assert.deepEqual(ids(), ["v1", "v2", "v3", "v4"], "the video playing now can't move");

  // Adding one that's already coming up moves it to the end.
  room.handle(host.id, { type: "queue-add", mediaIds: ["v2"] });
  assert.deepEqual(ids(), ["v1", "v3", "v4", "v2"]);

  // A countdown to a video that's taken out stops.
  room.advanceDelayMs = 60_000;
  room.handle(host.id, { type: "ended", mediaId: "v1" });
  assert.equal(room.queueInfo()?.advance?.mediaId, "v3");
  room.handle(host.id, { type: "queue-remove", mediaId: "v3" });
  assert.equal(room.queueInfo()?.advance, null);
  assert.deepEqual(ids(), ["v1", "v4", "v2"]);

  // Played videos stay for Previous; clearing keeps them and the one playing now.
  room.handle(host.id, { type: "select", mediaId: "v4" });
  room.handle(host.id, { type: "queue-clear" });
  assert.deepEqual(ids(), ["v1", "v4"]);
  assert.equal(room.summary().upNext, null);
  room.handle(host.id, { type: "select", mediaId: "v1" });
  room.handle(host.id, { type: "queue-clear" });
  assert.equal(room.queueInfo(), null, "just one video left isn't a queue");

  // Playing something else keeps Up next, right after the video that was playing.
  room.handle(host.id, { type: "queue-add", mediaIds: ["v2", "v3"] });
  room.handle(host.id, { type: "select", mediaId: "v5" });
  assert.deepEqual(ids(), ["v1", "v5", "v2", "v3"]);
  assert.equal(room.queueInfo()?.at, 1);
  mgr.rooms.clear();
});

test("adding to Up next with nothing playing picks the first video", () => {
  const vids: MediaItem[] = [1, 2].map((n) => ({ ...movie, id: `v${n}`, title: `Video ${n}` }));
  const mgr = new RoomManager((id) => vids.find((v) => v.id === id), Date.now, 1000);
  const room = mgr.create();
  const host = room.join("Host", () => {});
  room.handle(host.id, { type: "queue-add", mediaIds: ["v1", "v2"] });
  assert.equal(room.media?.id, "v1");
  assert.deepEqual(room.summary().upNext?.item.id, "v2");
  mgr.rooms.clear();
});

test("sentAt trusts the sender's time only when it is believable", () => {
  const now = 1_000_000;
  assert.equal(sentAt(now - 150, now), now - 150);
  assert.equal(sentAt(undefined, now), now);
  assert.equal(sentAt(now + 50, now), now, "a clock ahead of the server");
  assert.equal(sentAt(now - 60_000, now), now, "a clock far behind");
  assert.equal(sentAt("soon", now), now);
});

test("a jump while playing waits for every screen to load the spot, then plays for everyone", () => {
  const { room, a, alice, bob } = setup();
  const lastState = () => a.filter((m) => m.type === "state").at(-1) as Extract<ServerMessage, { type: "state" }>;
  room.handle(alice.id, { type: "player", on: true });
  room.handle(bob.id, { type: "player", on: true });
  room.handle(alice.id, { type: "play", position: 10 });
  room.handle(alice.id, { type: "seek", position: 60 });
  assert.deepEqual([lastState().state.paused, lastState().state.hold, lastState().state.position], [true, true, 60]);
  room.handle(alice.id, { type: "ready", position: 60 });
  assert.equal(lastState().state.hold, true, "still waiting for Bob");
  room.handle(bob.id, { type: "ready", position: 30 });
  assert.equal(lastState().state.hold, true, "a ready for another spot doesn't count");
  room.handle(bob.id, { type: "ready", position: 60.2 });
  assert.equal(lastState().state.paused, false);
  assert.equal(lastState().state.hold, undefined);
  assert.equal(lastState().state.position, 60);
  // Paused rooms, and rooms without newer apps, jump straight away as before.
  room.handle(alice.id, { type: "pause", position: 61 });
  room.handle(alice.id, { type: "seek", position: 90 });
  assert.equal(lastState().state.hold, undefined);
});

test("a hold gives up on slow or departed screens", async () => {
  const { room, a, alice, bob } = setup();
  const lastState = () => a.filter((m) => m.type === "state").at(-1) as Extract<ServerMessage, { type: "state" }>;
  room.holdMs = 5;
  room.handle(alice.id, { type: "player", on: true });
  room.handle(bob.id, { type: "player", on: true });
  room.handle(alice.id, { type: "play", position: 10 });
  room.handle(alice.id, { type: "seek", position: 60 });
  room.handle(alice.id, { type: "ready", position: 60 });
  room.leave(bob.id);
  assert.equal(lastState().state.paused, false, "Bob left, so nobody is left to wait for");
  room.handle(alice.id, { type: "player", on: true });
  room.join("Cara", () => {});
  const cara = [...room.members.values()].find((m) => m.member.name === "Cara")!.member;
  room.handle(cara.id, { type: "player", on: true });
  room.handle(alice.id, { type: "seek", position: 120 });
  room.handle(alice.id, { type: "ready", position: 120 });
  assert.equal(lastState().state.hold, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lastState().state.paused, false, "played anyway after the wait ran out");
  // Pressing pause during a hold just pauses.
  room.handle(alice.id, { type: "seek", position: 200 });
  room.handle(alice.id, { type: "pause", position: 200 });
  assert.deepEqual([lastState().state.paused, lastState().state.hold], [true, undefined]);
});

test("a hold that runs out with no screen ready waits for the first one", async () => {
  const { room, a, alice, bob } = setup();
  const lastState = () => a.filter((m) => m.type === "state").at(-1) as Extract<ServerMessage, { type: "state" }>;
  room.holdMs = 5;
  room.handle(alice.id, { type: "player", on: true });
  room.handle(bob.id, { type: "player", on: true });
  room.handle(alice.id, { type: "play", position: 10 });
  room.handle(alice.id, { type: "seek", position: 60 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lastState().state.hold, true, "nobody to start without");
  room.handle(bob.id, { type: "ready", position: 60 });
  assert.deepEqual([lastState().state.paused, lastState().state.hold], [false, undefined], "the first screen in starts it");
  // And not forever: holdMaxMs still ends it.
  room.holdMaxMs = 30;
  room.handle(alice.id, { type: "seek", position: 120 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(lastState().state.paused, false);
});

test("the log says when a screen the hold gave up on catches up, and which copy it plays", async () => {
  const { room, alice, bob, clock } = setup();
  const lines: string[] = [];
  room.log = (l) => lines.push(l);
  room.holdMs = 5;
  room.handle(alice.id, { type: "player", on: true });
  room.handle(bob.id, { type: "player", on: true });
  room.handle(alice.id, { type: "play", position: 10 });
  room.handle(alice.id, { type: "seek", position: 60 });
  room.handle(alice.id, { type: "ready", position: 60, converted: true });
  assert.ok(lines.some((l) => /loaded it after \d+ ms \(converted copy\)$/.test(l)), lines.join("\n"));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(lines.some((l) => l.includes("gave up waiting for")), lines.join("\n"));
  clock.tick(2500);
  room.handle(bob.id, { type: "ready", position: 62.5, late: true });
  assert.ok(lines.some((l) => /caught up 2500 ms after the jump, 2500 ms after the others started$/.test(l)), lines.join("\n"));
  // Said once; a screen that wasn't waited for says nothing.
  const count = lines.length;
  room.handle(bob.id, { type: "ready", position: 63, late: true });
  room.handle(alice.id, { type: "ready", position: 63, late: true });
  assert.equal(lines.length, count);
});

test("watching alone, the party pauses where it was when its screen goes", async () => {
  let now = 1_000;
  const mgr = new RoomManager((id) => (id === movie.id ? { ...movie, duration: 7200 } : undefined), () => now, 1000);
  const room = mgr.create(movie.id, undefined, 0, true);
  const lines: string[] = [];
  room.log = (l) => lines.push(l);
  const host = room.join("Host", () => {}, "tv");
  room.handle(host.id, { type: "play", position: 600 });
  room.soloGraceMs = 5;
  now += 30_000;
  room.leave(host.id);
  now += 20_000;
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([room.state.paused, room.state.position], [true, 630], "where the screen went, not where the wait ended");
  assert.deepEqual(lines, ["Host (tv) pressed play at 10:00", "paused at 10:30: nobody is watching"]);
  now += 60_000;
  assert.equal(room.position(), 630, "still there on return");
  // A dropped connection that comes back in time finds it still playing.
  const again = room.join("Host", () => {}, "tv");
  room.handle(again.id, { type: "play", position: 630 });
  room.soloGraceMs = 30;
  room.leave(again.id, "code 1006");
  assert.equal(lines.at(-1), "Host (tv) lost connection (code 1006)");
  room.join("Host", () => {}, "tv");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(room.state.paused, false);
  // A party with friends plays on when someone steps out.
  const party = mgr.create(movie.id);
  const a = party.join("A", () => {});
  party.handle(a.id, { type: "play", position: 600 });
  party.leave(a.id);
  assert.equal(party.state.paused, false);
});

test("ending with Save spot keeps where the party is, and a new party picks up there", () => {
  let now = 1_000;
  const ep = (n: number): MediaItem => ({ ...movie, id: `e${n}`, title: `Ep ${n}`, duration: 3000, episode: { show: "Show", season: 1, episode: n, title: null } });
  const lib = new Map([1, 2, 3].map((n) => [`e${n}`, ep(n)]));
  const mgr = new RoomManager((id) => lib.get(id), () => now, 1000);
  const room = mgr.create(undefined, ["e1", "e2", "e3"]);
  const host = room.join("Host", () => {});
  room.handle(host.id, { type: "play", position: 600 });
  now += 30_000;
  room.handle(host.id, { type: "end", save: true });
  const [spot] = mgr.spots.list();
  assert.deepEqual({ mediaId: spot.mediaId, position: spot.position, next: spot.next }, { mediaId: "e1", position: 630, next: ["e2", "e3"] });

  const again = mgr.create(undefined, [spot.mediaId, ...spot.next], spot.position);
  assert.equal(again.media?.id, "e1");
  assert.equal(again.state.position, 630);
  assert.equal(again.state.paused, true);
  assert.deepEqual(again.queue, ["e1", "e2", "e3"]);

  // At the credits, the spot is the next episode; one spot per show, so it replaces the first.
  const late = again.join("Host", () => {});
  again.handle(late.id, { type: "seek", position: 2990 });
  again.handle(late.id, { type: "end", save: true });
  assert.deepEqual(mgr.spots.list().map((s) => [s.mediaId, s.position, s.next]), [["e2", 0, ["e3"]]]);

  // Without Save spot, or with nothing worth coming back to, nothing is kept.
  const plain = mgr.create("e3");
  const h = plain.join("Host", () => {});
  plain.handle(h.id, { type: "end", save: true });
  assert.equal(mgr.spots.list().length, 1, "the first minute of a single video isn't worth saving");

  // The last video in its credits (where the server found them start, well before the last minute) isn't either.
  lib.set("e3", { ...ep(3), marks: { credits: 2700 } });
  const last = mgr.create("e3");
  const l = last.join("Host", () => {});
  last.handle(l.id, { type: "seek", position: 2750 });
  last.handle(l.id, { type: "end", save: true });
  assert.equal(mgr.spots.list().length, 1, "the credits of the last video aren't worth saving");
  const before = mgr.create("e3");
  const b = before.join("Host", () => {});
  before.handle(b.id, { type: "seek", position: 2650 });
  before.handle(b.id, { type: "end", save: true });
  assert.deepEqual(mgr.spots.list()[0].position, 2650, "just before them is");
});

test("a playing party's spot is kept on disk, hidden until the server restarts", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Spots } = await import("../src/spots.ts");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spots-")), "spots.json");
  let now = 1_000;
  const ep = (n: number): MediaItem => ({ ...movie, id: `e${n}`, title: `Ep ${n}`, duration: 3000, episode: { show: "Show", season: 1, episode: n, title: null } });
  const lib = new Map([1, 2].map((n) => [`e${n}`, ep(n)]));
  const mgr = new RoomManager((id) => lib.get(id), () => now, 1000, undefined, new Spots(file, () => now));
  // An older spot for the show, from an earlier party.
  const old = mgr.create("e1");
  const o = old.join("Host", () => {});
  old.handle(o.id, { type: "play", position: 100 });
  old.handle(o.id, { type: "end", save: true });

  const room = mgr.create(undefined, ["e1", "e2"]);
  const host = room.join("Host", () => {});
  room.handle(host.id, { type: "play", position: 600 });
  now += 30_000;
  mgr.keepSpots();
  assert.deepEqual(mgr.savedSpots().map((s) => s.position), [100], "Home doesn't show the party that's still on");

  // The server stops without asking anyone: the next one has the party's spot, in place of the show's older one.
  const after = new Spots(file, () => now);
  assert.deepEqual(after.list().map((s) => [s.mediaId, s.position, s.next, s.room]), [["e1", 630, ["e2"], undefined]]);

  // Ending with Don't save drops it, and the older spot is still there.
  room.handle(host.id, { type: "end", save: false });
  assert.deepEqual(mgr.savedSpots().map((s) => s.position), [100]);
  assert.deepEqual(new Spots(file, () => now).list().map((s) => s.position), [100]);
});

test("a party that empties out saves its spot when it's dropped, at the moment everyone left", () => {
  let now = 1_000;
  const long: MediaItem = { ...movie, duration: 7200 };
  const mgr = new RoomManager((id) => (id === long.id ? long : undefined), () => now, 1000);
  const room = mgr.create(long.id);
  const a = room.join("A", () => {});
  room.handle(a.id, { type: "play", position: 1200 });
  now += 60_000;
  room.leave(a.id);
  now += 5_000;
  mgr.sweep();
  assert.equal(mgr.rooms.size, 0);
  assert.deepEqual(mgr.spots.list().map((s) => [s.mediaId, s.position]), [["m1", 1260]]);
});

test("a party left sitting doesn't bring back an older spot once the show was watched in a newer one", () => {
  let now = 1_000;
  const long: MediaItem = { ...movie, duration: 7200 };
  const mgr = new RoomManager((id) => (id === long.id ? long : undefined), () => now, 1000);
  // The connection drops at 9:23; the host starts again in a new party and watches on.
  const stuck = mgr.create(long.id, undefined, 0, true);
  const a = stuck.join("Host", () => {}, "tv");
  stuck.handle(a.id, { type: "play", position: 563 });
  stuck.leave(a.id);
  now += 100;
  const fresh = mgr.create(long.id, undefined, 536, true);
  const b = fresh.join("Host", () => {}, "tv");
  fresh.handle(b.id, { type: "play", position: 536 });
  now += 2_000;
  mgr.sweep();
  assert.equal(mgr.rooms.has(stuck.id), false, "the stuck party is dropped");
  assert.deepEqual(mgr.spots.list(), [], "without saving 9:23 while the new party plays");
  // Same once the new party has ended (say in the credits, saving nothing).
  const stuck2 = mgr.create(long.id, undefined, 0, true);
  const c = stuck2.join("Host", () => {}, "tv");
  stuck2.handle(c.id, { type: "play", position: 563 });
  stuck2.leave(c.id);
  now += 100;
  fresh.end("Host");
  now += 2_000;
  mgr.sweep();
  assert.deepEqual(mgr.spots.list(), []);
});

test("watching alone stays off the party list until the host invites friends", () => {
  const mgr = new RoomManager((id) => (id === movie.id ? movie : undefined), () => 1_000, 1000);
  const room = mgr.create(movie.id, undefined, 0, true);
  const inbox: ServerMessage[] = [];
  const host = room.join("Jake", (m) => inbox.push(m));
  const welcome = inbox.find((m) => m.type === "welcome");
  assert.ok(welcome?.type === "welcome" && welcome.solo === true);
  assert.equal(mgr.joinable(room.id), undefined);
  assert.deepEqual(mgr.list(), []);
  const guest = room.join("Sam", () => {}, "web", () => {}, true);
  room.handle(guest.id, { type: "invite" });
  assert.equal(room.solo, true, "only the host invites");
  room.handle(host.id, { type: "invite" });
  assert.deepEqual(inbox.at(-1), { type: "solo", solo: false });
  assert.equal(mgr.joinable(room.id), room);
  assert.equal(mgr.list()[0].solo, false);
});

test("watching alone plays by itself once the host's screen has loaded the video", () => {
  const mgr = new RoomManager((id) => (id === movie.id ? movie : undefined), () => 1_000, 1000);
  const room = mgr.create(movie.id, undefined, 120, true);
  const inbox: ServerMessage[] = [];
  const host = room.join("Jake", (m) => inbox.push(m));
  room.handle(host.id, { type: "player", on: true });
  assert.deepEqual({ ...room.state, updatedAt: 0 }, { mediaId: movie.id, paused: true, position: 120, updatedAt: 0, hold: true });
  room.handle(host.id, { type: "ready", position: 120 });
  assert.equal(room.state.paused, false);
  assert.equal(room.state.position, 120);
  // A party still waits for the host to press play.
  const party = mgr.create(movie.id);
  const jake = party.join("Jake", () => {});
  party.handle(jake.id, { type: "player", on: true });
  assert.equal(party.state.paused, true);
});

test("Skip intro is a jump anyone can make, and friends see what it skipped", () => {
  const { room, b, alice, bob } = setup();
  room.handle(bob.id, { type: "seek", position: 95, skip: "intro" });
  const st = b.filter((m) => m.type === "state").at(-1);
  assert.ok(st?.type === "state" && st.state.position === 95);
  assert.equal(room.chat.at(-1)?.text, "Guest skipped the intro");
  room.handle(alice.id, { type: "seek", position: 20, skip: "recap" });
  assert.equal(room.chat.at(-1)?.text, "Alice skipped the recap");
  room.handle(alice.id, { type: "seek", position: 30, skip: "nonsense" as any });
  assert.equal(room.chat.at(-1)?.text, "Alice jumped to 0:30");
});
