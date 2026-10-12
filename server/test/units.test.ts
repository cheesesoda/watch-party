import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedPosition } from "../../shared/protocol.ts";
import { checkPassword, tokenFor } from "../src/auth.ts";
import { parseName, subtitleTag, titleFromFilename } from "../src/library.ts";
import { parseRange } from "../src/range.ts";
import { FailureLimiter } from "../src/ratelimit.ts";
import { srtToVtt } from "../src/subtitles.ts";

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
  assert.deepEqual(parseName("Planet Earth II - 1x02 - Mountains.mp4").episode, { show: "Planet Earth II", season: 1, episode: 2, title: "Mountains" });
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
