import fs from "node:fs/promises";
import { episodeLabel } from "../../shared/specials.ts";
import path from "node:path";
import type { MediaItem, MediaMeta } from "../../shared/protocol.ts";

export interface MetadataConfig {
  /** TMDB "API Read Access Token" (sent as a Bearer header). */
  token?: string;
  /** Or the older v3 API key (sent as ?api_key=). */
  apiKey?: string;
  /** TMDB language code for titles and overviews, e.g. "en-US". */
  language: string;
  /** JSON file the answers are kept in, so the server asks TMDB once per movie or season. */
  file: string;
}

interface MovieHit {
  id: number;
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  /** Wide background art. Missing (not null) in answers saved before backdrops were kept. */
  backdropPath?: string | null;
  /** TMDB's average score out of 10, or null with no votes. */
  rating?: number | null;
  genres?: string[];
}

interface ShowHit extends MovieHit {}

interface SeasonHit {
  posterPath: string | null;
  episodes: Record<number, { name: string | null; overview: string | null; stillPath: string | null; airDate?: string | null }>;
  /** Saved after air dates were kept; older saved seasons are asked for again. */
  dated?: boolean;
}

interface CacheEntry<T> {
  /** ms since epoch. */
  at: number;
  /** null: TMDB had nothing, asked again after RETRY_MISS_MS. */
  value: T | null;
  /** Chosen by the host with Fix match: never looked up again. */
  pinned?: boolean;
}

/** A search result the host can pick with Fix match. */
export interface MatchCandidate {
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
}

interface CacheFile {
  movies: Record<string, CacheEntry<MovieHit>>;
  shows: Record<string, CacheEntry<ShowHit>>;
  seasons: Record<string, CacheEntry<SeasonHit>>;
}

const API = "https://api.themoviedb.org/3";
const RETRY_MISS_MS = 7 * 24 * 60 * 60 * 1000;
const OFFLINE_RETRY_MS = 5 * 60 * 1000;
const OFFLINE = Symbol("offline");

const IMAGE = "https://image.tmdb.org/t/p";

/** A season saved before air dates were kept: asked for again (its old answer is used meanwhile). */
const undated = (kind: string, entry: CacheEntry<unknown>) => kind === "seasons" && entry.value !== null && !(entry.value as SeasonHit).dated;
/** Poster and still sizes the server passes along; TMDB has others, but these cover every screen. */
export const IMAGE_SIZES = new Set(["w92", "w185", "w342", "w500", "w300", "w780", "w1280"]);
const IMAGE_FILE = /^[A-Za-z0-9_-]+\.(jpg|png)$/;

const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** "Franklin and Bash" and "Franklin & Bash": TMDB's search only finds the spelling it has, so try both. */
function spellings(query: string): string[] {
  const all = [query, query.replace(/\s+and\s+/gi, " & "), query.replace(/\s*&\s*/g, " and ")];
  return all.filter((q, i) => all.findIndex((o) => o.toLowerCase() === q.toLowerCase()) === i);
}

/** Bumped when lookups get better, so answers of "not found" from older versions are asked again. */
const CACHE_VERSION = 2;
const movieKey = (item: MediaItem) => `${key(item.title)}|${item.year ?? ""}`;
const showKey = (name: string) => key(name);
const yearOf = (date: unknown) => (typeof date === "string" && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);
const text = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim() : null);

/** TMDB's genre ids, which search results give instead of names. They haven't changed in years. */
const GENRES: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama",
  10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance",
  878: "Science Fiction", 10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western", 10759: "Action & Adventure",
  10762: "Kids", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk",
  10768: "War & Politics",
};
function genresOf(hit: any): string[] {
  const named = Array.isArray(hit.genres) ? hit.genres.map((g: any) => text(g?.name)) : [];
  const ids = Array.isArray(hit.genre_ids) ? hit.genre_ids.map((id: any) => GENRES[id] ?? null) : [];
  return [...named, ...ids].filter((g): g is string => g !== null);
}
const ratingOf = (hit: any) =>
  typeof hit.vote_average === "number" && hit.vote_count > 0 ? Math.round(hit.vote_average * 10) / 10 : null;

/**
 * Movie and TV episode details from TMDB (themoviedb.org). Lookups run one at a time in the background
 * and are saved to disk, so the library answers immediately and details show up on later loads.
 */
export class Metadata {
  private cache: CacheFile = { movies: {}, shows: {}, seasons: {} };
  private loaded: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();
  private disabled = false;
  /** After TMDB can't be reached, lookups wait until then instead of each failing and logging. */
  private offlineUntil = 0;

  constructor(
    private config: MetadataConfig,
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = Date.now,
    private pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.loaded = this.enabled ? this.load() : Promise.resolve();
  }

  get enabled() {
    return !this.disabled && Boolean(this.config.token || this.config.apiKey);
  }

  /** The item with whatever TMDB details are already known; missing ones are looked up for next time. */
  enrich(item: MediaItem): MediaItem {
    if (!this.enabled || item.extra) return item;
    if (item.episode) return this.enrichEpisode(item);
    const movie = this.lookup("movies", movieKey(item), () => this.findMovie(item.title, item.year ?? null), (m) => this.refresh("movie", m));
    if (!movie) return item;
    return {
      ...item,
      meta: {
        tmdbId: movie.id,
        title: movie.title,
        year: movie.year,
        overview: movie.overview,
        posterPath: movie.posterPath,
        backdropPath: movie.backdropPath ?? null,
        rating: movie.rating ?? null,
        genres: movie.genres ?? [],
      },
    };
  }

  private enrichEpisode(item: MediaItem): MediaItem {
    const ep = item.episode!;
    const show = this.lookup("shows", showKey(ep.show), () => this.findShow(ep.show), (s) => this.refresh("tv", s));
    if (!show) return item;
    const season = this.lookup("seasons", `${show.id}|${ep.season}`, () => this.findSeason(show.id, ep.season));
    const details = season?.episodes[ep.episode];
    const meta: MediaMeta = {
      tmdbId: show.id,
      title: details?.name ?? show.title,
      year: show.year,
      overview: details?.overview ?? show.overview,
      posterPath: season?.posterPath ?? show.posterPath,
      stillPath: details?.stillPath ?? null,
      airDate: details?.airDate ?? null,
      show: show.title,
      showPosterPath: show.posterPath,
      showOverview: show.overview,
      backdropPath: show.backdropPath ?? null,
      rating: show.rating ?? null,
      genres: show.genres ?? [],
    };
    // TMDB's episode name wins: most rips have none ("Show.S01E02.mkv"), and others carry a dubbed or tagged one
    // ("La Citta Dell Amore Fraterno ITA ENG AMZN"). Every client shows it.
    if (details?.name) {
      const title = `${ep.show} ${episodeLabel(ep.season, ep.episode)} · ${details.name}`;
      return { ...item, title, episode: { ...ep, title: details.name }, meta };
    }
    return { ...item, meta };
  }

  /**
   * Looks up everything in the library ahead of time, so details are ready before anyone opens it.
   * Runs twice because a TV season can only be asked for once its show has been found.
   */
  async warm(items: MediaItem[]): Promise<void> {
    if (!this.enabled) return;
    for (let round = 0; round < 2; round++) {
      for (const item of items) this.enrich(item);
      await this.idle();
    }
  }

  /** TMDB movies or shows matching a search, for Fix match. */
  async search(kind: "movie" | "tv", query: string): Promise<MatchCandidate[]> {
    await this.loaded;
    if (!this.enabled) return [];
    const results = await this.search_(kind, query, {});
    return results.slice(0, 12).map((hit) => {
      const { id, ...rest } = this.toHit(kind, hit, query);
      return { tmdbId: id, title: rest.title, year: rest.year, overview: rest.overview, posterPath: rest.posterPath };
    });
  }

  /**
   * Fix match: ties the item's movie (or, for an episode, its whole show) to a TMDB id the host picked,
   * or to nothing with null. Returns the item with its new details.
   */
  async setMatch(item: MediaItem, tmdbId: number | null): Promise<MediaItem> {
    await this.loaded;
    if (!this.enabled) throw new Error("Movie details are off. Add TMDB_TOKEN to the server's .env.");
    const kind = item.episode ? "tv" : "movie";
    let value: MovieHit | null = null;
    if (tmdbId !== null) {
      const data = await this.get(`/${kind}/${tmdbId}`, {});
      if (!data || typeof data.id !== "number") throw new Error("TMDB doesn't have that one.");
      value = this.toHit(kind, data, item.episode?.show ?? item.title);
    }
    const entry = { at: this.now(), value, pinned: true };
    if (item.episode) this.cache.shows[showKey(item.episode.show)] = entry;
    else this.cache.movies[movieKey(item)] = entry;
    this.scheduleSave();
    // A newly matched show's season is looked up now, so the answer can already have its episode names.
    if (item.episode && value) {
      this.enrich(item);
      await this.idle();
    }
    return this.enrich(item);
  }

  /** The path of a TMDB poster or still saved on this server, downloading it the first time. */
  async image(size: string, file: string): Promise<string | null> {
    if (!IMAGE_SIZES.has(size) || !IMAGE_FILE.test(file) || !this.config.file) return null;
    const local = path.join(path.dirname(this.config.file), "images", size, file);
    try {
      await fs.access(local);
      return local;
    } catch {}
    const res = await this.fetchImpl(`${IMAGE}/${size}/${file}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    await fs.mkdir(path.dirname(local), { recursive: true });
    const tmp = `${local}.${process.pid}.tmp`;
    await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    await fs.rename(tmp, local);
    return local;
  }

  /** Resolves once every lookup started so far has finished and been saved (for tests). */
  async idle(): Promise<void> {
    await this.loaded;
    let last: Promise<unknown>;
    do {
      last = this.queue;
      await last;
    } while (last !== this.queue);
    await this.flush();
  }

  async close(): Promise<void> {
    await this.idle().catch(() => {});
  }

  private lookup<K extends keyof CacheFile>(
    kind: K,
    id: string,
    find: () => Promise<CacheFile[K][string]["value"]>,
    /** For a movie or show saved before backdrops were kept: asks TMDB again by its id, keeping the match. */
    refresh?: (value: MovieHit) => Promise<MovieHit | null>,
  ): CacheFile[K][string]["value"] {
    const entry = this.cache[kind][id];
    const old = refresh && entry?.value && (entry.value as MovieHit).backdropPath === undefined;
    const fresh = entry && !old && !undated(kind, entry) && (entry.value !== null || entry.pinned || this.now() - entry.at < RETRY_MISS_MS);
    const task = `${kind}:${id}`;
    if (old && !this.pending.has(task)) {
      this.pending.add(task);
      this.queue = this.queue
        .then(() => (this.enabled ? refresh(entry.value as MovieHit) : null))
        .then((value) => {
          const now = this.cache[kind][id];
          if (!value || now !== entry) return;
          (this.cache[kind] as Record<string, CacheEntry<unknown>>)[id] = { ...entry, value };
          this.scheduleSave();
        })
        .catch((err) => {
          if (err !== OFFLINE) console.warn(`TMDB lookup failed (${task}): ${err instanceof Error ? err.message : err}`);
        })
        .finally(() => this.pending.delete(task));
    } else if (!fresh && !this.pending.has(task)) {
      this.pending.add(task);
      this.queue = this.queue
        .then(() => this.loaded)
        .then(async () => {
          if (!this.enabled) return;
          // The file may already have it now that it's loaded.
          const cached = this.cache[kind][id];
          if (cached && !undated(kind, cached) && (cached.value !== null || cached.pinned || this.now() - cached.at < RETRY_MISS_MS)) return;
          const value = await find();
          (this.cache[kind] as Record<string, CacheEntry<unknown>>)[id] = { at: this.now(), value };
          this.scheduleSave();
        })
        .catch((err) => {
          if (err === OFFLINE) return;
          if (err instanceof TypeError || (err as Error)?.name === "TimeoutError") {
            // fetch() itself failed: no internet, DNS, timeout. Say so once and try again later.
            this.offlineUntil = this.now() + OFFLINE_RETRY_MS;
            console.warn(`Can't reach TMDB (${err.message}); trying again in a few minutes.`);
          } else {
            console.warn(`TMDB lookup failed (${task}): ${err instanceof Error ? err.message : err}`);
          }
        })
        .finally(() => this.pending.delete(task));
    }
    return entry?.value ?? null;
  }

  private async findMovie(title: string, year: number | null): Promise<MovieHit | null> {
    for (const q of spellings(title)) {
      let results = await this.search_("movie", q, year ? { year: String(year) } : {});
      // A wrong year in the file name shouldn't hide the movie altogether.
      if (results.length === 0 && year) results = await this.search_("movie", q, {});
      if (results[0]) return this.toHit("movie", results[0], title);
    }
    return null;
  }

  private async findShow(name: string): Promise<ShowHit | null> {
    for (const q of spellings(name)) {
      const hit = (await this.search_("tv", q, {}))[0];
      if (hit) return this.toHit("tv", hit, name);
    }
    return null;
  }

  private toHit(kind: "movie" | "tv", hit: any, fallback: string): MovieHit {
    const title = text(kind === "movie" ? hit.title : hit.name) ?? fallback;
    return {
      id: hit.id,
      title,
      year: yearOf(kind === "movie" ? hit.release_date : hit.first_air_date),
      overview: text(hit.overview),
      posterPath: text(hit.poster_path),
      backdropPath: text(hit.backdrop_path),
      rating: ratingOf(hit),
      genres: genresOf(hit),
    };
  }

  /** The same movie or show asked for again by id, for details older saved answers lack. */
  private async refresh(kind: "movie" | "tv", value: MovieHit): Promise<MovieHit | null> {
    const data = await this.get(`/${kind}/${value.id}`, {});
    if (!data || typeof data.id !== "number") return { ...value, backdropPath: null };
    return this.toHit(kind, data, value.title);
  }

  private async findSeason(showId: number, season: number): Promise<SeasonHit | null> {
    const data = await this.get(`/tv/${showId}/season/${season}`, {});
    if (!data) return null;
    const episodes: SeasonHit["episodes"] = {};
    for (const e of Array.isArray(data.episodes) ? data.episodes : []) {
      if (typeof e?.episode_number !== "number") continue;
      episodes[e.episode_number] = { name: text(e.name), overview: text(e.overview), stillPath: text(e.still_path), airDate: text(e.air_date) };
    }
    return { posterPath: text(data.poster_path), episodes, dated: true };
  }

  private async search_(kind: "movie" | "tv", query: string, extra: Record<string, string>): Promise<any[]> {
    const data = await this.get(`/search/${kind}`, { query, include_adult: "false", ...extra });
    return Array.isArray(data?.results) ? data.results.filter((r: any) => typeof r?.id === "number") : [];
  }

  /** One TMDB request. null for 404; throws on other failures so the lookup is retried on a later load. */
  private async get(pathname: string, params: Record<string, string>, attempt = 0): Promise<any> {
    if (this.disabled) return null;
    if (this.now() < this.offlineUntil) throw OFFLINE;
    const url = new URL(API + pathname);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("language", this.config.language);
    if (!this.config.token && this.config.apiKey) url.searchParams.set("api_key", this.config.apiKey);
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;

    const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (res.status === 401) {
      this.disabled = true;
      console.warn("TMDB refused the key (401). Check TMDB_TOKEN in .env; movie details are off until the server restarts.");
      return null;
    }
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get("retry-after")) || 2;
      await this.pause(wait * 1000);
      return this.get(pathname, params, attempt + 1);
    }
    if (!res.ok) throw new Error(`TMDB answered ${res.status}`);
    // TMDB allows about 50 requests a second; a short gap keeps a first big scan well under that.
    await this.pause(50);
    return res.json();
  }

  private async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.config.file, "utf8"));
      this.cache = { movies: data.movies ?? {}, shows: data.shows ?? {}, seasons: data.seasons ?? {} };
      if ((data.version ?? 1) < CACHE_VERSION) {
        for (const table of Object.values(this.cache) as Record<string, CacheEntry<unknown>>[]) {
          for (const [id, entry] of Object.entries(table)) if (entry.value === null && !entry.pinned) delete table[id];
        }
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") console.warn(`Couldn't read ${this.config.file}, starting with no movie details: ${err?.message ?? err}`);
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => void this.flush(), 2000);
  }

  private async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saving = this.saving.then(() => this.write()).catch((err) => console.warn(`Couldn't save movie details: ${err?.message ?? err}`));
    }
    await this.saving;
  }

  private async write() {
    await fs.mkdir(path.dirname(this.config.file), { recursive: true });
    const tmp = `${this.config.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, ...this.cache }));
    await fs.rename(tmp, this.config.file);
  }
}
