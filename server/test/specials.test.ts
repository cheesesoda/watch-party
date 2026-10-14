import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaItem } from "../../shared/protocol.ts";
import { weave } from "../../shared/specials.ts";

const ep = (season: number, episode: number, airDate?: string): MediaItem => ({
  id: `${season}x${episode}`, title: "", relPath: "", folder: "", size: 1, mime: "video/mp4", subtitles: [],
  episode: { show: "Letterkenny", season, episode, title: null },
  meta: airDate ? { tmdbId: 1, title: "", year: null, overview: null, posterPath: null, airDate } : undefined,
});
const ids = (list: MediaItem[]) => list.map((e) => e.id);

test("specials are woven in where they aired, and the rest go at the end", () => {
  const show = [
    ep(2, 1, "2017-12-25"), ep(1, 2, "2016-02-14"), ep(1, 1, "2016-02-07"), ep(2, 2, "2018-01-01"),
    ep(0, 3), // no date
    ep(0, 2, "2017-12-25"), // same day as 2x1: after it
    ep(0, 1, "2016-12-20"), // between seasons: after 1x2, so in season 1
    ep(0, 4, "2015-01-01"), // before everything: starts season 1
  ];
  const w = weave(show);
  assert.deepEqual(ids(w.all), ["0x4", "1x1", "1x2", "0x1", "2x1", "0x2", "2x2", "0x3"]);
  assert.deepEqual(ids(w.seasons.get(1)!), ["0x4", "1x1", "1x2", "0x1"]);
  assert.deepEqual(ids(w.seasons.get(2)!), ["2x1", "0x2", "2x2"]);
  assert.deepEqual(ids(w.specials), ["0x1", "0x2", "0x3", "0x4"]);
  assert.equal(w.seasons.has(0), false);
});

test("without air dates, specials only go at the end of the whole binge", () => {
  const w = weave([ep(1, 2), ep(0, 1, "2016-12-20"), ep(1, 1)]);
  assert.deepEqual(ids(w.all), ["1x1", "1x2", "0x1"]);
  assert.deepEqual(ids(w.seasons.get(1)!), ["1x1", "1x2"]);
  assert.deepEqual(ids(weave([ep(0, 2), ep(0, 1)]).all), ["0x1", "0x2"]);
});
