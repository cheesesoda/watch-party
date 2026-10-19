import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { MediaItem } from "../../shared/protocol.ts";
import { History } from "../src/history.ts";
import { RoomManager } from "../src/rooms.ts";

const base: MediaItem = { id: "m1", title: "Movie", relPath: "Movie.mp4", folder: "", size: 1, mime: "video/mp4", subtitles: [] };
const ep = (n: number, extra: Partial<MediaItem> = {}): MediaItem => ({ ...base, id: `e${n}`, title: `Ep ${n}`, duration: 3000, episode: { show: "Show", season: 1, episode: n, title: null }, ...extra });

function setup(file?: string) {
  let now = 1_000;
  const lib = new Map([1, 2, 3].map((n) => [`e${n}`, ep(n, n === 1 ? { marks: { credits: 2700 } } : {})]));
  const history = new History(file, () => now);
  const mgr = new RoomManager((id) => lib.get(id), () => now, 1000, undefined, undefined, history);
  return { mgr, history, lib, tick: (ms: number) => (now += ms) };
}

test("a party that plays leaves a play with everyone in it, and how far it got", () => {
  const { mgr, history, tick } = setup();
  const room = mgr.create("e2");
  const jake = room.join("Jake", () => {}, "tv");
  room.join("jake", () => {}, "web");
  mgr.keepSpots();
  assert.deepEqual(history.list(), [], "opened but never played isn't a play");
  room.handle(jake.id, { type: "play", position: 0 });
  tick(30_000);
  room.join("Sam", () => {});
  tick(100_000);
  mgr.keepSpots();
  const [play] = history.list();
  assert.deepEqual([play.mediaId, play.position, play.names, play.solo, play.watched], ["e2", 130, ["Jake", "Sam"], false, false]);
  assert.deepEqual(history.state("e2"), { watchedAt: null, position: 130, updatedAt: 131_000 });
  tick(15_000);
  mgr.keepSpots();
  assert.equal(history.list().length, 1, "the same play goes on");
  assert.equal(history.list()[0].position, 145);
});

test("reaching the credits marks it watched, even when the binge moves on between looks", () => {
  const { mgr, history, tick } = setup();
  const room = mgr.create(undefined, ["e1", "e2"]);
  const host = room.join("Host", () => {});
  room.handle(host.id, { type: "play", position: 2690 });
  tick(12_000);
  // The Up next countdown ends and e2 starts before the 15 s look: e1's play is still noted where it got to.
  room.handle(host.id, { type: "select", mediaId: "e2" });
  assert.deepEqual(history.state("e1")?.watchedAt, 13_000, "in the credits (2702 s, they start at 2700)");
  assert.equal(history.state("e1")?.position, null);
  assert.equal(history.list()[0].watched, true);
  tick(70_000);
  room.handle(host.id, { type: "end", save: false });
  assert.deepEqual(history.list().map((p) => [p.mediaId, p.watched, Math.round(p.position)]), [["e2", false, 70], ["e1", true, 2702]]);
  assert.deepEqual(history.state("e2")?.position, 70);
});

test("without a credits mark, the last minute counts as watched", () => {
  const { mgr, history, tick } = setup();
  const room = mgr.create("e3");
  const host = room.join("Host", () => {});
  room.handle(host.id, { type: "seek", position: 2930 });
  room.handle(host.id, { type: "play", position: 2930 });
  tick(15_000);
  mgr.keepSpots();
  assert.equal(history.state("e3")?.watchedAt, 16_000);
});

test("Watch alone plays say so; a short look isn't progress", () => {
  const { mgr, history, tick } = setup();
  const room = mgr.create("e2", undefined, 0, true);
  const host = room.join("Jake", () => {});
  room.handle(host.id, { type: "play", position: 0 });
  tick(20_000);
  mgr.keepSpots();
  assert.equal(history.list()[0].solo, true);
  assert.equal(history.state("e2"), undefined, "20 s in isn't partly watched");
});

test("marked by hand; not watched forgets how far it got; kept on disk", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "history-")), "history.json");
  const { mgr, history, tick } = setup(file);
  const room = mgr.create("e2");
  const host = room.join("Host", () => {});
  room.handle(host.id, { type: "play", position: 300 });
  tick(15_000);
  mgr.keepSpots();
  history.mark(["e1", "e3"], true);
  history.mark(["e2"], false);
  const again = new History(file);
  assert.equal(again.state("e1")?.watchedAt, 16_000);
  assert.equal(again.state("e2"), undefined);
  assert.deepEqual(again.list().map((p) => p.mediaId), ["e2"]);
});
