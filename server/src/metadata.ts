import fs from "node:fs/promises";
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
}

interface ShowHit extends MovieHit {}

interface SeasonHit {
  posterPath: string | null;
  episodes: Record<number, { name: string | null; overview: string | null; stillPath: string | null }>;
}

interface CacheEntry<T> {
  /** ms since epoch. */
  at: number;
  /** null: TMDB had nothing, asked again after RETRY_MISS_MS. */
  value: T | null;
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

const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const yearOf = (date: unknown) => (typeof date === "string" && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);
const text = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim() : null);

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
    const movieKey = `${key(item.title)}|${item.year ?? ""}`;
    const movie = this.lookup("movies", movieKey, () => this.findMovie(item.title, item.year ?? null));
    if (!movie) return item;
    return { ...item, meta: { tmdbId: movie.id, title: movie.title, year: movie.year, overview: movie.overview, posterPath: movie.posterPath } };
  }

  private enrichEpisode(item: MediaItem): MediaItem {
    const ep = item.episode!;
    const show = this.lookup("shows", key(ep.show), () => this.findShow(ep.show));
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
      show: show.title,
    };
    // Most rips are named "Show.S01E02.mkv" with no episode title; fill it in so every client shows it.
    if (!ep.title && details?.name) {
      return { ...item, title: `${item.title} · ${details.name}`, episode: { ...ep, title: details.name }, meta };
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
  ): CacheFile[K][string]["value"] {
    const entry = this.cache[kind][id];
    const fresh = entry && (entry.value !== null || this.now() - entry.at < RETRY_MISS_MS);
    const task = `${kind}:${id}`;
    if (!fresh && !this.pending.has(task)) {
      this.pending.add(task);
      this.queue = this.queue
        .then(() => this.loaded)
        .then(async () => {
          if (!this.enabled) return;
          // The file may already have it now that it's loaded.
          const cached = this.cache[kind][id];
          if (cached && (cached.value !== null || this.now() - cached.at < RETRY_MISS_MS)) return;
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
    let results = await this.search("movie", title, year ? { year: String(year) } : {});
    // A wrong year in the file name shouldn't hide the movie altogether.
    if (results.length === 0 && year) results = await this.search("movie", title, {});
    const hit = results[0];
    if (!hit) return null;
    return { id: hit.id, title: text(hit.title) ?? title, year: yearOf(hit.release_date), overview: text(hit.overview), posterPath: text(hit.poster_path) };
  }

  private async findShow(name: string): Promise<ShowHit | null> {
    const hit = (await this.search("tv", name, {}))[0];
    if (!hit) return null;
    return { id: hit.id, title: text(hit.name) ?? name, year: yearOf(hit.first_air_date), overview: text(hit.overview), posterPath: text(hit.poster_path) };
  }

  private async findSeason(showId: number, season: number): Promise<SeasonHit | null> {
    const data = await this.get(`/tv/${showId}/season/${season}`, {});
    if (!data) return null;
    const episodes: SeasonHit["episodes"] = {};
    for (const e of Array.isArray(data.episodes) ? data.episodes : []) {
      if (typeof e?.episode_number !== "number") continue;
      episodes[e.episode_number] = { name: text(e.name), overview: text(e.overview), stillPath: text(e.still_path) };
    }
    return { posterPath: text(data.poster_path), episodes };
  }

  private async search(kind: "movie" | "tv", query: string, extra: Record<string, string>): Promise<any[]> {
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
    await fs.writeFile(tmp, JSON.stringify(this.cache));
    await fs.rename(tmp, this.config.file);
  }
}
