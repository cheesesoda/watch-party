import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { MediaItem } from "../../shared/protocol.ts";
import { Metadata } from "../src/metadata.ts";

let dir: string;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-meta-"));
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const item = (over: Partial<MediaItem>): MediaItem => ({ id: "x", title: "", relPath: "", folder: "", size: 1, mime: "video/mp4", subtitles: [], ...over });

/** A stand-in for TMDB that answers from a table and records what was asked. */
function fakeTmdb(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: URL, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(`${url.pathname}?${url.searchParams.get("query") ?? ""}|${url.searchParams.get("year") ?? ""}`);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer tok");
    const body = routes[url.pathname];
    if (body === undefined) return new Response("{}", { status: 404 });
    if (typeof body === "number") return new Response("{}", { status: body });
    return Response.json(body);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const config = (name: string) => ({ token: "tok", language: "en-US", file: path.join(dir, name, "metadata.json") });
const noPause = async () => {};

test("movies get TMDB details on the next load, and the answer is saved", async () => {
  const tmdb = fakeTmdb({
    "/3/search/movie": { results: [{ id: 4944, title: "Burn After Reading", release_date: "2008-09-05", overview: "A disk falls…", poster_path: "/bar.jpg" }] },
  });
  const movie = item({ title: "Burn After Reading", year: 2008 });
  const meta = new Metadata(config("movies"), tmdb.fetchImpl, Date.now, noPause);
  assert.equal(meta.enrich(movie).meta, undefined);
  await meta.idle();
  assert.deepEqual(meta.enrich(movie).meta, { tmdbId: 4944, title: "Burn After Reading", year: 2008, overview: "A disk falls…", posterPath: "/bar.jpg" });
  assert.deepEqual(tmdb.calls, ["/3/search/movie?Burn After Reading|2008"]);

  // A restarted server reads the file instead of asking again.
  const again = new Metadata(config("movies"), fakeTmdb({}).fetchImpl, Date.now, noPause);
  await again.idle();
  assert.equal(again.enrich(movie).meta?.tmdbId, 4944);
});

test("episodes without a title in the file name get TMDB's episode name", async () => {
  const tmdb = fakeTmdb({
    "/3/search/tv": { results: [{ id: 1399, name: "Game of Thrones", first_air_date: "2011-04-17", overview: "Seven noble families…", poster_path: "/got.jpg" }] },
    "/3/tv/1399/season/1": { poster_path: "/s1.jpg", episodes: [{ episode_number: 1, name: "Winter Is Coming", overview: "Ned Stark…", still_path: "/e1.jpg" }] },
  });
  const ep = item({ title: "Game of Thrones S1 E1", episode: { show: "Game of Thrones", season: 1, episode: 1, title: null } });
  const meta = new Metadata(config("shows"), tmdb.fetchImpl, Date.now, noPause);
  await meta.warm([ep]);
  const got = meta.enrich(ep);
  assert.equal(got.title, "Game of Thrones S1 E1 · Winter Is Coming");
  assert.equal(got.episode?.title, "Winter Is Coming");
  assert.deepEqual(got.meta, { tmdbId: 1399, title: "Winter Is Coming", year: 2011, overview: "Ned Stark…", posterPath: "/s1.jpg", stillPath: "/e1.jpg", show: "Game of Thrones" });

  // A title from the file name is kept.
  const named = item({ title: "Game of Thrones S1 E1 · Pilot", episode: { show: "Game of Thrones", season: 1, episode: 1, title: "Pilot" } });
  assert.equal(meta.enrich(named).title, "Game of Thrones S1 E1 · Pilot");
});

test("no match is remembered for a week, extras are skipped, and a refused key turns lookups off", async () => {
  let now = 1_000;
  const tmdb = fakeTmdb({ "/3/search/movie": { results: [] } });
  const meta = new Metadata(config("misses"), tmdb.fetchImpl, () => now, noPause);
  const home = item({ title: "Home Video", year: 2019 });
  meta.enrich(home);
  meta.enrich(item({ title: "Trailer", extra: { kind: "Trailer", of: "Home Video", show: null } }));
  await meta.idle();
  // Searched with the year, then without it.
  assert.deepEqual(tmdb.calls, ["/3/search/movie?Home Video|2019", "/3/search/movie?Home Video|"]);
  meta.enrich(home);
  await meta.idle();
  assert.equal(tmdb.calls.length, 2);
  now += 8 * 24 * 60 * 60 * 1000;
  meta.enrich(home);
  await meta.idle();
  assert.equal(tmdb.calls.length, 4);

  const refused = new Metadata(config("refused"), fakeTmdb({ "/3/search/movie": 401 }).fetchImpl, Date.now, noPause);
  refused.enrich(home);
  await refused.idle();
  assert.equal(refused.enabled, false);
});

test("without a token nothing is looked up", async () => {
  const meta = new Metadata({ language: "en-US", file: path.join(dir, "off.json") }, (() => assert.fail("fetched")) as unknown as typeof fetch);
  const movie = item({ title: "Alien", year: 1979 });
  assert.equal(meta.enrich(movie), movie);
  await meta.idle();
});

test("when TMDB can't be reached, lookups pause instead of each failing", async () => {
  let now = 1_000;
  let calls = 0;
  const offline = (async () => {
    calls++;
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const meta = new Metadata(config("offline"), offline, () => now, noPause);
  const movies = ["A", "B", "C"].map((title) => item({ title }));
  await meta.warm(movies);
  assert.equal(calls, 1);
  now += 6 * 60 * 1000;
  movies.forEach((m) => meta.enrich(m));
  await meta.idle();
  assert.equal(calls, 2);
});
