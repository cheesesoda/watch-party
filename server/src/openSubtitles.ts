import fs from "node:fs/promises";
import path from "node:path";
import type { MediaItem, SubtitleResult } from "../../shared/protocol.ts";
import { parseCues } from "./subtitleRecaps.ts";

/**
 * Find subtitles: English subtitles from OpenSubtitles (opensubtitles.com) for videos that came without any. Saved in
 * the server's data folder as "<video id>.en.srt", never beside the video, and picked up by the next library scan.
 */

export interface OpenSubtitlesConfig {
  /** The consumer's API key (OPENSUBTITLES_API_KEY); off without one. */
  apiKey?: string;
  /** An opensubtitles.com account, for the account's daily downloads rather than the smaller allowance without one. */
  username?: string;
  password?: string;
  /** Where downloaded subtitles go (data/subtitles). */
  dir: string;
}

const API = "https://api.opensubtitles.com/api/v1";
/** OpenSubtitles asks every app to name itself. */
const USER_AGENT = "PopcornClub v1";
/** Logins last a day; renewed a little before. */
const TOKEN_MS = 23 * 3600_000;
/** How many results the dialog lists. */
const MAX_RESULTS = 8;
const CHUNK = 64 * 1024;

/**
 * OpenSubtitles' hash of a video file: its size plus the sum of its first and last 64 KB read as 64-bit numbers,
 * as 16 hex digits. Matching it means a subtitle was timed against this very file.
 */
export async function movieHash(file: string): Promise<string | null> {
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    if (size < CHUNK) return null;
    const mask = (1n << 64n) - 1n;
    let sum = BigInt(size);
    for (const at of [0, size - CHUNK]) {
      const buf = Buffer.alloc(CHUNK);
      await handle.read(buf, 0, CHUNK, at);
      for (let i = 0; i < CHUNK; i += 8) sum = (sum + buf.readBigUInt64LE(i)) & mask;
    }
    return sum.toString(16).padStart(16, "0");
  } finally {
    await handle.close();
  }
}

/** Where a video's downloaded subtitles are kept. */
export const downloadedFile = (dir: string, id: string) => path.join(dir, `${id}.en.srt`);

export class OpenSubtitles {
  private token: { value: string; until: number } | null = null;
  private left: number | null = null;

  constructor(
    private config: OpenSubtitlesConfig,
    private fetcher: typeof fetch = (...args) => fetch(...args),
    private now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return !!this.config.apiKey;
  }

  /** Downloads left today, once OpenSubtitles has said (after signing in or a download); null before. */
  get remaining(): number | null {
    return this.left;
  }

  /** English subtitles for [item] (a movie or an episode), ones made for this very file first, then the most downloaded. */
  async search(item: MediaItem, absPath: string): Promise<SubtitleResult[]> {
    await this.login().catch((err) => console.warn(`subtitles: OpenSubtitles sign-in failed: ${(err as Error).message}`));
    const params = new URLSearchParams({ languages: "en" });
    const hash = await movieHash(absPath);
    if (hash) params.set("moviehash", hash);
    const ep = item.episode;
    const tmdb = item.meta?.tmdbId;
    if (ep) {
      params.set("type", "episode");
      if (tmdb) params.set("parent_tmdb_id", String(tmdb));
      else params.set("query", ep.show);
      params.set("season_number", String(ep.season));
      params.set("episode_number", String(ep.episode));
    } else {
      params.set("type", "movie");
      if (tmdb) params.set("tmdb_id", String(tmdb));
      else {
        params.set("query", item.title);
        if (item.year) params.set("year", String(item.year));
      }
    }
    // OpenSubtitles wants its parameters in order, or it redirects.
    params.sort();
    const body = (await this.call(`/subtitles?${params}`)) as { data?: { attributes?: Record<string, unknown> }[] };
    const results: SubtitleResult[] = [];
    for (const row of body.data ?? []) {
      const a = row.attributes ?? {};
      const file = (a.files as { file_id?: number }[] | undefined)?.[0];
      // Machine translations are poor, and an English one means the original was in another language anyway.
      if (!file?.file_id || a.ai_translated || a.machine_translated) continue;
      results.push({
        fileId: file.file_id,
        release: String(a.release || item.title).slice(0, 200),
        downloads: Number(a.download_count) || 0,
        hashMatch: a.moviehash_match === true,
        hearingImpaired: a.hearing_impaired === true,
      });
    }
    results.sort((x, y) => Number(y.hashMatch) - Number(x.hashMatch) || y.downloads - x.downloads);
    return results.slice(0, MAX_RESULTS);
  }

  /** Downloads one of search's results for the video [id] and saves it; the next library scan adds it to the video. */
  async download(id: string, fileId: number): Promise<void> {
    await this.login().catch(() => {});
    const res = (await this.call("/download", { file_id: fileId })) as { link?: string; remaining?: number };
    if (typeof res.remaining === "number") this.left = res.remaining;
    if (!res.link) throw new Error("OpenSubtitles didn't give a download link.");
    const file = await this.fetcher(res.link);
    if (!file.ok) throw new Error(`the download failed (${file.status})`);
    const text = await file.text();
    if (parseCues(text).length === 0) throw new Error("the download wasn't a subtitle file");
    await fs.mkdir(this.config.dir, { recursive: true });
    const out = downloadedFile(this.config.dir, id);
    await fs.writeFile(`${out}.tmp`, text);
    await fs.rename(`${out}.tmp`, out);
  }

  private async login(): Promise<void> {
    if (!this.config.username || !this.config.password) return;
    if (this.token && this.token.until > this.now()) return;
    this.token = null;
    const res = (await this.call("/login", { username: this.config.username, password: this.config.password })) as {
      token?: string;
      user?: { remaining_downloads?: number };
    };
    if (!res.token) throw new Error("no sign-in token");
    this.token = { value: res.token, until: this.now() + TOKEN_MS };
    if (typeof res.user?.remaining_downloads === "number") this.left = res.user.remaining_downloads;
  }

  private async call(route: string, body?: unknown): Promise<unknown> {
    if (!this.config.apiKey) throw new Error("Find subtitles needs an OpenSubtitles API key.");
    const headers: Record<string, string> = { "Api-Key": this.config.apiKey, "User-Agent": USER_AGENT, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token.value}`;
    const res = await this.fetcher(API + route, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { message?: string; remaining?: number };
    if (!res.ok) {
      if (typeof data.remaining === "number") this.left = data.remaining;
      throw new Error(data.message || `OpenSubtitles answered ${res.status}`);
    }
    return data;
  }
}
