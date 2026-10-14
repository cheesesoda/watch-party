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
    "/3/search/movie": { results: [{ id: 4944, title: "Burn After Reading", release_date: "2008-09-05", overview: "A disk falls…", poster_path: "/bar.jpg", backdrop_path: "/bar-wide.jpg", vote_average: 6.96, vote_count: 900, genre_ids: [35, 80] }] },
  });
  const movie = item({ title: "Burn After Reading", year: 2008 });
  const meta = new Metadata(config("movies"), tmdb.fetchImpl, Date.now, noPause);
  assert.equal(meta.enrich(movie).meta, undefined);
  await meta.idle();
  assert.deepEqual(meta.enrich(movie).meta, { tmdbId: 4944, title: "Burn After Reading", year: 2008, overview: "A disk falls…", posterPath: "/bar.jpg", backdropPath: "/bar-wide.jpg", rating: 7, genres: ["Comedy", "Crime"] });
  assert.deepEqual(tmdb.calls, ["/3/search/movie?Burn After Reading|2008"]);

  // A restarted server reads the file instead of asking again.
  const again = new Metadata(config("movies"), fakeTmdb({}).fetchImpl, Date.now, noPause);
  await again.idle();
  assert.equal(again.enrich(movie).meta?.tmdbId, 4944);
});

test("episodes get TMDB's episode name, whatever the file calls them", async () => {
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
  assert.deepEqual(got.meta, { tmdbId: 1399, title: "Winter Is Coming", year: 2011, overview: "Ned Stark…", posterPath: "/s1.jpg", stillPath: "/e1.jpg", airDate: null, show: "Game of Thrones", showPosterPath: "/got.jpg", showOverview: "Seven noble families…", backdropPath: null, rating: null, genres: [] });

  // A dubbed or tagged title from the file name gives way to TMDB's.
  const named = item({ title: "Game of Thrones S1 E1 · L Inverno Sta Arrivando ITA", episode: { show: "Game of Thrones", season: 1, episode: 1, title: "L Inverno Sta Arrivando ITA" } });
  assert.equal(meta.enrich(named).title, "Game of Thrones S1 E1 · Winter Is Coming");
  assert.equal(meta.enrich(named).episode?.title, "Winter Is Coming");
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

test("Fix match ties a movie or a whole show to the TMDB id the host picked", async () => {
  const tmdb = fakeTmdb({
    "/3/search/movie": { results: [{ id: 1, title: "Wrong", release_date: "1990-01-01" }, { id: 2, title: "Right", release_date: "2001-01-01" }] },
    "/3/movie/2": { id: 2, title: "Right", release_date: "2001-01-01", overview: "The one.", poster_path: "/r.jpg" },
    "/3/search/tv": { results: [{ id: 10, name: "Office (UK)", first_air_date: "2001-07-09" }] },
    "/3/tv/20": { id: 20, name: "The Office", first_air_date: "2005-03-24", poster_path: "/us.jpg" },
    "/3/tv/20/season/2": { episodes: [{ episode_number: 1, name: "The Dundies" }] },
  });
  const meta = new Metadata(config("fix"), tmdb.fetchImpl, Date.now, noPause);
  const movie = item({ title: "Right", year: null });
  await meta.warm([movie]);
  assert.equal(meta.enrich(movie).meta?.tmdbId, 1);
  assert.deepEqual((await meta.search("movie", "right")).map((c) => c.tmdbId), [1, 2]);
  assert.equal((await meta.setMatch(movie, 2)).meta?.overview, "The one.");

  const ep = item({ title: "The Office S2 E1", episode: { show: "The Office", season: 2, episode: 1, title: null } });
  const fixed = await meta.setMatch(ep, 20);
  assert.equal(fixed.title, "The Office S2 E1 · The Dundies");
  assert.equal(fixed.meta?.tmdbId, 20);

  // "None of these" keeps it bare, for good.
  assert.equal((await meta.setMatch(movie, null)).meta, undefined);
  await meta.idle();
  const reloaded = new Metadata(config("fix"), fakeTmdb({}).fetchImpl, () => Date.now() + 365 * 24 * 60 * 60 * 1000, noPause);
  await reloaded.warm([movie, ep]);
  assert.equal(reloaded.enrich(movie).meta, undefined);
  assert.equal(reloaded.enrich(ep).meta?.tmdbId, 20);
});

test("posters are downloaded once and only for known sizes and plain file names", async () => {
  let downloads = 0;
  const fetchImpl = (async (input: string) => {
    downloads++;
    assert.equal(input, "https://image.tmdb.org/t/p/w342/abc.jpg");
    return new Response(new Uint8Array([1, 2, 3]));
  }) as unknown as typeof fetch;
  const meta = new Metadata(config("images"), fetchImpl, Date.now, noPause);
  const file = await meta.image("w342", "abc.jpg");
  assert.deepEqual([...(await fs.readFile(file!))], [1, 2, 3]);
  assert.equal(await meta.image("w342", "abc.jpg"), file);
  assert.equal(downloads, 1);
  assert.equal(await meta.image("original", "abc.jpg"), null);
  assert.equal(await meta.image("w342", "..%2Fsecret.jpg"), null);
});

test("a show is found whether the folder says \"and\" or \"&\", and older misses are asked again", async () => {
  const fetchImpl = (async (input: URL) => {
    const url = new URL(input);
    const q = url.searchParams.get("query");
    if (url.pathname === "/3/search/tv") return Response.json({ results: q === "Franklin & Bash" ? [{ id: 7, name: "Franklin & Bash" }] : [] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const file = config("and").file;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ shows: { "franklin and bash": { at: Date.now(), value: null } } }));
  const meta = new Metadata(config("and"), fetchImpl, Date.now, noPause);
  const ep = (show: string) => item({ title: `${show} S1 E1`, episode: { show, season: 1, episode: 1, title: null } });
  await meta.warm([ep("Franklin and Bash"), ep("Franklin And Bash")]);
  assert.equal(meta.enrich(ep("Franklin and Bash")).meta?.tmdbId, 7);
  assert.equal(meta.enrich(ep("Franklin And Bash")).meta?.tmdbId, 7);
  assert.equal(meta.enrich(ep("Franklin & Bash")).meta?.tmdbId, 7);
});

test("movies and shows saved before backdrops were kept are asked for again by id, keeping Fix match", async () => {
  const tmdb = fakeTmdb({
    "/3/movie/5": { id: 5, title: "Old", release_date: "1999-01-01", backdrop_path: "/old-wide.jpg", genres: [{ id: 18, name: "Drama" }] },
  });
  const file = config("refresh").file;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const value = { id: 5, title: "Old", year: 1999, overview: null, posterPath: "/old.jpg" };
  await fs.writeFile(file, JSON.stringify({ version: 2, movies: { "old|1999": { at: 1, value, pinned: true } } }));
  const movie = item({ title: "Old", year: 1999 });
  const meta = new Metadata(config("refresh"), tmdb.fetchImpl, Date.now, noPause);
  await meta.warm([movie]);
  assert.deepEqual(tmdb.calls, ["/3/movie/5?|"]);
  assert.equal(meta.enrich(movie).meta?.backdropPath, "/old-wide.jpg");
  assert.deepEqual(meta.enrich(movie).meta?.genres, ["Drama"]);
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.movies["old|1999"].pinned, true);
});

test("episodes carry their air date, and seasons saved before air dates were kept are asked for again", async () => {
  const tmdb = fakeTmdb({
    "/3/tv/7/season/0": { episodes: [{ episode_number: 1, name: "A Letterkenny Christmas", air_date: "2019-12-25" }] },
  });
  const file = config("dated").file;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const show = { id: 7, title: "Letterkenny", year: 2016, overview: null, posterPath: null, backdropPath: null };
  const season = { posterPath: null, episodes: { 1: { name: "A Letterkenny Christmas", overview: null, stillPath: null } } };
  await fs.writeFile(file, JSON.stringify({ version: 2, shows: { letterkenny: { at: Date.now(), value: show } }, seasons: { "7|0": { at: Date.now(), value: season } } }));
  const ep = item({ title: "Letterkenny S0 E1", episode: { show: "Letterkenny", season: 0, episode: 1, title: null } });
  const meta = new Metadata(config("dated"), tmdb.fetchImpl, Date.now, noPause);
  await meta.warm([ep]);
  assert.deepEqual(tmdb.calls, ["/3/tv/7/season/0?|"]);
  assert.equal(meta.enrich(ep).meta?.airDate, "2019-12-25");
});
