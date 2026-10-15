import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { expectedPosition } from "../../shared/protocol.ts";
import { checkPassword, tokenFor } from "../src/auth.ts";
import { findFolderExtras, Library, linkExtras, linkParts, nameFromFolder, parseName, subtitleTag, titleFromFilename } from "../src/library.ts";
import type { MediaItem } from "../../shared/protocol.ts";
import { parseRange } from "../src/range.ts";
import { FailureLimiter } from "../src/ratelimit.ts";
import { srtToVtt } from "../src/subtitles.ts";
import { loadConfig } from "../src/config.ts";

test("parseRange", () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=0-1,5-6", 100), { start: 0, end: 1 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=20-10", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseRange("items=0-1", 100), null);
});

test("titleFromFilename", () => {
  assert.equal(titleFromFilename("/m/The.Matrix.1999.1080p.mp4"), "The Matrix 1999 1080p");
  assert.equal(titleFromFilename("my_home__video.mkv"), "my home video");
});

test("parseName reads titles, years and episodes from file names", () => {
  const movie = (title: string, year: number | null) => ({ title, year, episode: null });
  assert.deepEqual(parseName("Movies/The.Matrix.1999.1080p.BluRay.x264.mp4"), movie("The Matrix", 1999));
  assert.deepEqual(parseName("Alien (1979).mkv"), movie("Alien", 1979));
  assert.deepEqual(parseName("2001 A Space Odyssey (1968).mkv"), movie("2001 A Space Odyssey", 1968));
  assert.deepEqual(parseName("2001.mkv"), movie("2001", null));
  assert.deepEqual(parseName("Blade Runner 2049 (2017).mp4"), movie("Blade Runner 2049", 2017));
  assert.deepEqual(parseName("my_home__video.mkv"), movie("my home video", null));
  assert.deepEqual(parseName("Arrival.2160p.WEB-DL.mkv"), movie("Arrival", null));

  assert.deepEqual(parseName("TV/Severance.S02E04.Woes.Hollow.1080p.WEB.mkv"), {
    title: "Severance S2 E4 · Woes Hollow",
    year: null,
    episode: { show: "Severance", season: 2, episode: 4, title: "Woes Hollow" },
  });
  assert.deepEqual(parseName("TV/Doctor Who (2005)/Season 1/Doctor.Who.2005.S01E01.mkv").episode, { show: "Doctor Who", season: 1, episode: 1, title: null });
  assert.deepEqual(parseName("TV/The Bear/Season 3/S03E10.mkv").episode, { show: "The Bear", season: 3, episode: 10, title: null });
  assert.deepEqual(parseName("TV/Letterkenny/Specials/S00E01.mkv").episode, { show: "Letterkenny", season: 0, episode: 1, title: null });
  assert.deepEqual(parseName("TV/Game of Thrones/Season 1/Game.of.Thrones.S01E01.1080p.BluRay.x265.mkv").episode, { show: "Game of Thrones", season: 1, episode: 1, title: null });
  assert.equal(parseName("Game of Thrones - S01E02 - The Kingsroad (1080p BluRay x265).mkv").episode?.title, "The Kingsroad");
  assert.equal(parseName("TV/Reacher/Season 4/Reacher.S04E01.La.Citta.Dell.Amore.Fraterno.ITA.ENG.AMZN.WEB-DL.mkv").episode?.title, "La Citta Dell Amore Fraterno");
  assert.deepEqual(parseName("Planet Earth II - 1x02 - Mountains.mp4").episode, { show: "Planet Earth II", season: 1, episode: 2, title: "Mountains" });
});

test("extras are found by Plex-style suffix or folder and linked to their movie or show", () => {
  assert.deepEqual(parseName("Films/Burn After Reading (2008)/DC Insiders-behindthescenes.mkv").extra, { kind: "Behind the scenes", ownerFolder: "Films/Burn After Reading (2008)" });
  assert.equal(parseName("Films/Burn After Reading (2008)/Finding the Burn-behindthescenes.mkv").title, "Finding the Burn");
  assert.deepEqual(parseName("Films/Alien (1979)/Trailers/Teaser.mkv").extra, { kind: "Trailer", ownerFolder: "Films/Alien (1979)" });
  assert.deepEqual(parseName("TV/Severance/Featurettes/Making Lumon.mkv").extra, { kind: "Featurette", ownerFolder: "TV/Severance" });
  assert.equal(parseName("TV/Doctor Who/Specials/Doctor.Who.S00E01.mkv").extra, undefined);
  assert.equal(parseName("Trailers.mkv").extra, undefined);

  const item = (id: string, relPath: string): MediaItem => {
    const p = parseName(relPath);
    return { id, title: p.title, relPath, folder: relPath.slice(0, relPath.lastIndexOf("/")), size: 1, mime: "video/mp4", subtitles: [], episode: p.episode };
  };
  const items = [
    item("burn", "Films/Burn After Reading (2008)/Burn After Reading (2008).mkv"),
    item("dc", "Films/Burn After Reading (2008)/DC Insiders-behindthescenes.mkv"),
    item("ep", "TV/Severance/Season 1/Severance.S01E01.mkv"),
    item("lumon", "TV/Severance/Featurettes/Making Lumon.mkv"),
    item("loose", "Films/Random-trailer.mkv"),
    item("a", "Films/A.mkv"),
    item("b", "Films/B.mkv"),
  ];
  const extras = new Map(items.flatMap((i) => (parseName(i.relPath).extra ? [[i.id, parseName(i.relPath).extra!] as const] : [])));
  linkExtras(items, extras);
  assert.deepEqual(items[1].extra, { kind: "Behind the scenes", of: "burn", show: null });
  assert.deepEqual(items[3].extra, { kind: "Featurette", of: null, show: "Severance" });
  // Two movies share the folder, so it's unclear which one the trailer belongs to.
  assert.deepEqual(items[4].extra, { kind: "Trailer", of: null, show: null });
  assert.equal(items[0].extra, undefined);
});

test("other videos in a movie's own folder are its extras", () => {
  const item = (id: string, relPath: string, size: number): MediaItem => ({
    id, title: parseName(relPath).title, relPath, folder: relPath.slice(0, relPath.lastIndexOf("/")), size, mime: "video/mp4", subtitles: [],
  });
  const items = [
    item("burn", "Films/Burn After Reading (2008)/Burn.After.Reading.2008.1080p.mkv", 8000),
    item("dc", "Films/Burn After Reading (2008)/DC Insiders.mkv", 300),
    item("big", "Films/Heat (1995)/heat_main.mkv", 9000),
    item("clip", "Films/Heat (1995)/Making of.mkv", 900),
    item("cut1", "Films/Blade Runner (1982)/Final Cut.mkv", 9000),
    item("cut2", "Films/Blade Runner (1982)/Theatrical.mkv", 8800),
    item("a", "Films/Alien (1979).mkv", 5000),
    item("b", "Films/Arrival (2016).mkv", 100),
  ];
  const extras = new Map<string, { kind: string; ownerFolder: string }>();
  findFolderExtras(items, extras);
  linkExtras(items, extras);
  assert.deepEqual(items[1].extra, { kind: "Extra", of: "burn", show: null });
  assert.deepEqual(items[3].extra, { kind: "Extra", of: "big", show: null });
  // Two cuts of similar size: neither is an extra. A folder of many movies isn't touched either.
  assert.deepEqual([items[0], items[2], items[4], items[5], items[6], items[7]].map((i) => i.extra), [undefined, undefined, undefined, undefined, undefined, undefined]);
});

test("a movie file named without a year takes its title and year from its folder", () => {
  const item = (id: string, relPath: string, size = 1000): MediaItem => {
    const { title, year } = parseName(relPath);
    return { id, title, year, relPath, folder: relPath.slice(0, relPath.lastIndexOf("/")), size, mime: "video/mp4", subtitles: [], episode: null };
  };
  const items = [
    item("groove", "Movies/The.Emperors.New.Groove.2000.1080p.BluRay.X264-Japhson [PublicHD]/japhson-groove-1080p.mkv"),
    item("heat", "Films/Heat (1995)/heat_main.mkv", 9000),
    item("clip", "Films/Heat (1995)/Making of.mkv", 900),
    item("named", "Films/Alien (1979)/Alien.Directors.Cut.1979.mkv"),
    item("a", "Films/Loose One.mkv"),
    item("b", "Films/Loose Two.mkv"),
  ];
  const extras = new Map<string, { kind: string; ownerFolder: string }>();
  findFolderExtras(items, extras);
  nameFromFolder(items, extras);
  assert.deepEqual(items.map((i) => [i.title, i.year]), [
    ["The Emperors New Groove", 2000],
    ["Heat", 1995],
    ["Making of", null],
    ["Alien Directors Cut", 1979],
    ["Loose One", null],
    ["Loose Two", null],
  ]);
});

test("subtitleTag", () => {
  assert.equal(subtitleTag("/m/Movie.mp4", "/m/Movie.srt"), "");
  assert.equal(subtitleTag("/m/Movie.mp4", "/m/Movie.en.forced.vtt"), "en.forced");
  assert.equal(subtitleTag("/m/Movie.mp4", "/m/Movie 2.srt"), null);
  assert.equal(subtitleTag("/m/Movie.mp4", "/m/Movie.en.txt"), null);
});

test("srtToVtt", () => {
  const vtt = srtToVtt("﻿1\r\n00:00:01,500 --> 00:00:02,000\r\nHi\r\n");
  assert.equal(vtt, "WEBVTT\n\n1\n00:00:01.500 --> 00:00:02.000\nHi\n");
});

test("auth tokens", () => {
  assert.equal(tokenFor("pw"), tokenFor("pw"));
  assert.notEqual(tokenFor("pw"), tokenFor("pw2"));
  assert.ok(checkPassword("pw", "pw"));
  assert.ok(!checkPassword("pw", "px"));
  assert.ok(!checkPassword("pw", undefined));
});

test("expectedPosition", () => {
  assert.equal(expectedPosition({ mediaId: "a", paused: true, position: 10, updatedAt: 0 }, 5000), 10);
  assert.equal(expectedPosition({ mediaId: "a", paused: false, position: 10, updatedAt: 0 }, 5000), 15);
});

test("FailureLimiter blocks after the limit and forgets old failures", () => {
  let now = 0;
  const lim = new FailureLimiter(3, 1000, () => now);
  lim.fail("a");
  lim.fail("a");
  assert.equal(lim.blockedFor("a"), 0);
  lim.fail("a");
  assert.equal(lim.blockedFor("a"), 1);
  assert.equal(lim.blockedFor("b"), 0);
  now = 1001;
  assert.equal(lim.blockedFor("a"), 0);
  lim.fail("a");
  lim.reset("a");
  assert.equal(lim.blockedFor("a"), 0);
});

test("ICE_SERVERS parsing normalizes urls and rejects junk", async () => {
  const { parseIceServers } = await import("../src/config.ts");
  assert.deepEqual(parseIceServers(undefined), [{ urls: ["stun:stun.l.google.com:19302"] }]);
  assert.deepEqual(parseIceServers('[{"urls":"turn:t.example:3478","username":"u","credential":"p"}]'), [
    { urls: ["turn:t.example:3478"], username: "u", credential: "p" },
  ]);
  assert.throws(() => parseIceServers("{}"));
  assert.throws(() => parseIceServers("[{}]"));
});

test("a movie split into parts is one movie whose parts know each other", () => {
  assert.deepEqual(parseName("Films/Grindhouse (2007)/Grindhouse (2007) Pt 1.mp4"), { title: "Grindhouse", year: 2007, episode: null, part: 1, fullTitle: "Grindhouse (2007) Pt 1" });
  assert.equal(parseName("Kill.Bill.2003.1080p.CD2.mkv").part, 2);
  assert.equal(parseName("Rocky Part 2.mkv").part, 2);
  assert.equal(parseName("Apollo 13 (1995).mkv").part, undefined);
  const item = (id: string, relPath: string) => {
    const p = parseName(relPath);
    return { id, title: p.title, relPath, folder: relPath.slice(0, relPath.lastIndexOf("/")), size: 1, mime: "video/mp4", subtitles: [], year: p.year } as MediaItem;
  };
  const items = [item("p2", "Films/Grindhouse (2007)/Grindhouse (2007) Pt 2.mp4"), item("p1", "Films/Grindhouse (2007)/Grindhouse (2007) Pt 1.mp4"), item("r", "Films/Rocky Part 2.mkv")];
  linkParts(items, new Map(items.map((i) => [i.id, { part: parseName(i.relPath).part!, fullTitle: parseName(i.relPath).fullTitle! }])));
  assert.deepEqual(items[1].part, { index: 1, ids: ["p1", "p2"] });
  assert.deepEqual(items[0].part, { index: 2, ids: ["p1", "p2"] });
  assert.equal(items[2].part, undefined, "a lone Part 2 is just a movie");
  assert.equal(items[2].title, "Rocky Part 2");
  const extras = new Map();
  findFolderExtras(items, extras);
  assert.equal(extras.size, 0, "the second part isn't an extra");
});

test("INVITE_URL drops a trailing slash and is optional", () => {
  assert.equal(loadConfig({ INVITE_URL: "https://tv.chzsda.com/" }).inviteUrl, "https://tv.chzsda.com");
  assert.equal(loadConfig({}).inviteUrl, undefined);
});

test("spots: newest first, one per key, at most six, expire after 30 days, saved to disk", async () => {
  const { Spots, SPOT_TTL_MS } = await import("../src/spots.ts");
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const file = pathMod.join(fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "spots-")), "spots.json");
  let now = 1_000;
  const spots = new Spots(file, () => now);
  for (let i = 0; i < 8; i++) {
    now += 1;
    spots.add({ mediaId: `m${i}`, position: i, next: [], key: `k${i}` });
  }
  spots.add({ mediaId: "again", position: 0, next: [], key: "k7" });
  assert.deepEqual(spots.list().map((s) => s.mediaId), ["again", "m6", "m5", "m4", "m3", "m2"]);
  assert.deepEqual(new Spots(file, () => now).list().map((s) => s.mediaId), ["again", "m6", "m5", "m4", "m3", "m2"]);
  assert.ok(spots.remove(spots.list()[0].id));
  now += SPOT_TTL_MS;
  assert.equal(spots.list().length, 0);
});

test("worthSaving: partway in, or with more lined up", async () => {
  const { worthSaving } = await import("../../shared/protocol.ts");
  assert.equal(worthSaving(30, 3000, 0), false);
  assert.equal(worthSaving(30, 3000, 2), true);
  assert.equal(worthSaving(1200, 3000, 0), true);
  assert.equal(worthSaving(2950, 3000, 0), false);
  assert.equal(worthSaving(2950, 3000, 1), true);
  assert.equal(worthSaving(1200, null, 0), true);
  // In the credits (where the server found them start) counts as the end too.
  assert.equal(worthSaving(2700, 3000, 0, 2650), false);
  assert.equal(worthSaving(2600, 3000, 0, 2650), true);
  assert.equal(worthSaving(2700, 3000, 1, 2650), true);
});

test("the library says when a later scan finds new or changed videos", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-lib-"));
  try {
    await fs.writeFile(path.join(dir, "A Movie (2001).mp4"), "a");
    const library = new Library([dir]);
    let calls = 0;
    library.onNew = () => calls++;
    await library.scan();
    assert.equal(calls, 0, "not the first scan: the server looks at everything on start");
    await library.scan();
    assert.equal(calls, 0, "nothing new");
    await fs.writeFile(path.join(dir, "B Movie (2002).mkv"), "b");
    await library.scan();
    assert.equal(calls, 1, "a file added");
    await fs.writeFile(path.join(dir, "B Movie (2002).mkv"), "bigger");
    await library.scan();
    assert.equal(calls, 2, "a file replaced");
    await fs.rm(path.join(dir, "A Movie (2001).mp4"));
    await library.scan();
    assert.equal(calls, 2, "a file removed needs no scan");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
