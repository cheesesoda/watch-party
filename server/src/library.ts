import crypto from "node:crypto";
import { episodeLabel } from "../../shared/specials.ts";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtraInfo, MediaItem, SubtitleTrack } from "../../shared/protocol.ts";
import { subtitleLabel } from "./transcode.ts";

export const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".ts": "video/mp2t",
};
const SUBTITLE_EXTS = new Set([".srt", ".vtt"]);

export interface LibraryEntry {
  item: MediaItem;
  absPath: string;
  subtitlePaths: string[];
}

/** "The.Matrix.1999.1080p" -> "The Matrix 1999 1080p" */
export function titleFromFilename(file: string): string {
  const base = path.basename(file, path.extname(file));
  return base.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Release tags that mark the end of a title in a file name, e.g. "Movie 1080p BluRay x264". */
const JUNK = /^(\d{3,4}p|4k|uhd|hdr\d*|dv|bluray|blu-ray|bdrip|brrip|web|webrip|web-dl|webdl|hdtv|dvdrip|remux|x26[45]|h26[45]|hevc|avc|aac\d*|ac3|dts|ddp?\d*|atmos|10bit|proper|repack|extended|unrated|imax|amzn|nf|dsnp|hmax|atvp|pcok|ita|eng|multi)$/i;

function clean(text: string): string {
  return text.replace(/[._]+/g, " ").replace(/\s+/g, " ").replace(/^[\s\-–·:]+|[\s\-–·:(\[]+$/g, "").trim();
}

/**
 * Drops release tags from the first one onward: "Movie 1080p BluRay" -> "Movie". A title keeps its first
 * word ("1917"); an episode title doesn't need to, so "S01E01.1080p.BluRay" has none.
 */
function untag(text: string, keepFirst = true): string {
  const words = clean(text).split(" ");
  const cut = words.findIndex((w, i) => (i > 0 || !keepFirst) && JUNK.test(w.replace(/[()[\]]/g, "")));
  return clean((cut === -1 ? words : words.slice(0, cut)).join(" "));
}

export interface ParsedName {
  title: string;
  year: number | null;
  episode: { show: string; season: number; episode: number; title: string | null } | null;
  /** For bonus material: what kind, and the folder whose movie or show it belongs to. */
  extra?: { kind: string; ownerFolder: string } | null;
  /** "Pt 2", "Part 2", "CD2", "Disc 2": one file of a movie split into several, and the title with the part left in. */
  part?: number | null;
  fullTitle?: string;
}

/** "Pt 1", "Part.2", "cd1", "Disc 2" at the end of a movie's file name. */
const PART = /(?:^|[\s._\-[(])(?:pt|part|cd|disc|disk)[\s._-]?(\d{1,2})\)?$/i;

/** Plex's names for bonus material: a "-trailer" style suffix on the file, or a folder of that kind. */
const EXTRA_SUFFIXES: Record<string, string> = {
  behindthescenes: "Behind the scenes",
  deleted: "Deleted scene",
  featurette: "Featurette",
  interview: "Interview",
  scene: "Scene",
  short: "Short",
  trailer: "Trailer",
  other: "Extra",
};
const EXTRA_FOLDERS: Record<string, string> = {
  "behind the scenes": "Behind the scenes",
  "deleted scenes": "Deleted scene",
  featurettes: "Featurette",
  interviews: "Interview",
  scenes: "Scene",
  shorts: "Short",
  trailers: "Trailer",
  other: "Extra",
  extras: "Extra",
  specials: "Extra",
};

/** "Burn After Reading/DC Insiders-behindthescenes.mkv" or "Alien/Trailers/Teaser.mkv" -> an extra. */
export function parseExtra(relPath: string): { title: string; kind: string; ownerFolder: string } | null {
  const parts = relPath.split("/");
  const file = parts[parts.length - 1];
  const base = path.basename(file, path.extname(file));
  const folder = parts.slice(0, -1).join("/");
  const suffix = base.match(/-(behindthescenes|deleted|featurette|interview|scene|short|trailer|other)$/i);
  if (suffix) {
    return { title: clean(base.slice(0, suffix.index)) || titleFromFilename(base), kind: EXTRA_SUFFIXES[suffix[1].toLowerCase()], ownerFolder: folder };
  }
  const dir = parts.length > 1 ? clean(parts[parts.length - 2]).toLowerCase() : "";
  // "Specials" is a season 0 folder for shows; files there are usually episodes, so only plain names count.
  if (parts.length > 2 && EXTRA_FOLDERS[dir] && !(dir === "specials" && /s\d+e\d+/i.test(base))) {
    return { title: untag(base) || titleFromFilename(base), kind: EXTRA_FOLDERS[dir], ownerFolder: parts.slice(0, -2).join("/") };
  }
  return null;
}

/**
 * Reads a title, year and TV episode from a path like "Alien (1979).mkv", "The.Matrix.1999.1080p.mp4",
 * "Severance.S02E04.Woes.Hollow.mkv" or "Severance/Season 2/S02E04.mkv".
 */
export function parseName(relPath: string): ParsedName {
  const extra = parseExtra(relPath);
  if (extra) return { title: extra.title, year: null, episode: null, extra: { kind: extra.kind, ownerFolder: extra.ownerFolder } };
  const parts = relPath.split("/");
  const base = path.basename(parts[parts.length - 1], path.extname(parts[parts.length - 1]));
  const ep = base.match(/(?:^|[\s._\-[(])s(\d{1,2})[\s._-]?e(\d{1,3})(?:-?e\d{1,3})?(?=$|[\s._\-\])])/i) ?? base.match(/(?:^|[\s._-])(\d{1,2})x(\d{2,3})(?=$|[\s._-])/i);
  if (ep) {
    // "Doctor.Who.2005.S01E01": the year only tells shows with the same name apart, so it's dropped.
    let show = clean(untag(base.slice(0, ep.index! + (/^[\s._\-[(]/.test(ep[0]) ? 1 : 0))).replace(/\(?(19|20)\d{2}\)?$/, ""));
    if (!show) {
      // "Show/Season 2/S02E04.mkv" or "Show/Specials/S00E01.mkv": use the nearest folder that isn't a season folder.
      const folders = parts.slice(0, -1).reverse();
      show = clean(folders.find((f) => !/^((season|series|s)\s*\d+|specials)$/i.test(clean(f))) ?? "");
    }
    const season = Number(ep[1]);
    const episode = Number(ep[2]);
    const epTitle = untag(base.slice(ep.index! + ep[0].length), false) || null;
    const name = show || titleFromFilename(base);
    return {
      title: `${name} ${episodeLabel(season, episode)}${epTitle ? ` · ${epTitle}` : ""}`,
      year: null,
      episode: { show: name, season, episode, title: epTitle },
    };
  }
  const part = clean(base).match(PART);
  if (part) {
    const movie = parseName(relPath.slice(0, relPath.length - path.basename(relPath).length) + clean(base).slice(0, part.index) + path.extname(relPath));
    if (movie.title && !movie.episode) return { ...movie, part: Number(part[1]), fullTitle: untag(base) };
  }
  // The last 19xx/20xx that isn't the start of the name is the year, so "2001 A Space Odyssey 1968" works.
  const years = [...base.matchAll(/(?<=^|[\s._\-[(])((?:19|20)\d{2})(?=$|[\s._\-\])])/g)].filter((m) => m.index! > 0);
  const y = years[years.length - 1];
  if (y && Number(y[1]) <= new Date().getFullYear() + 1) {
    return { title: untag(base.slice(0, y.index!)) || titleFromFilename(base), year: Number(y[1]), episode: null };
  }
  return { title: untag(base) || titleFromFilename(base), year: null, episode: null };
}

/**
 * A movie whose file name has no year ("japhson-groove-1080p.mkv") takes its title and year from its folder
 * ("The.Emperors.New.Groove.2000.1080p.BluRay"), when that folder has a year and holds no other movie.
 */
export function nameFromFolder(items: MediaItem[], extras: Map<string, { kind: string; ownerFolder: string }>): void {
  const movies = new Map<string, MediaItem[]>();
  for (const i of items) {
    if (i.folder === "" || i.episode || extras.has(i.id) || i.part) continue;
    movies.set(i.folder, [...(movies.get(i.folder) ?? []), i]);
  }
  for (const [folder, [movie, ...others]] of movies) {
    if (others.length || movie.year != null) continue;
    const named = parseName(folder.slice(folder.lastIndexOf("/") + 1) + ".mkv");
    if (named.year == null || named.episode || !named.title) continue;
    movie.title = named.title;
    movie.year = named.year;
  }
}

/**
 * Extras without a Plex-style name: in a movie's own folder ("Burn After Reading (2008)/"), the movie is the file
 * named like the folder, or else (when the folder has a year) a file at least twice the size of any other. The other
 * videos there are its extras. Folders that hold several movies, like "Films/", have neither, so they're left alone.
 */
export function findFolderExtras(items: MediaItem[], extras: Map<string, { kind: string; ownerFolder: string }>): void {
  const byFolder = new Map<string, MediaItem[]>();
  for (const i of items) {
    // A split movie counts once, as its first part.
    if (i.folder === "" || i.episode || extras.has(i.id) || (i.part && i.part.index > 1)) continue;
    byFolder.set(i.folder, [...(byFolder.get(i.folder) ?? []), i]);
  }
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const [folder, videos] of byFolder) {
    if (videos.length < 2) continue;
    const named = parseName(folder.slice(folder.lastIndexOf("/") + 1) + ".mkv");
    const same = videos.filter((v) => key(v.title) === key(named.title));
    let movie = same.length === 1 ? same[0] : null;
    if (!movie && named.year) {
      const [big, next] = [...videos].sort((a, b) => b.size - a.size);
      if (big.size >= 2 * next.size) movie = big;
    }
    if (!movie) continue;
    for (const v of videos) if (v !== movie) extras.set(v.id, { kind: "Extra", ownerFolder: folder });
  }
}

/**
 * Files of one movie split into parts (same folder, title and year, numbered "Pt 1", "Pt 2"…) learn about each
 * other, so the library lists the movie once and plays the parts back to back. A lone "Part 2" stays as it is.
 */
export function linkParts(items: MediaItem[], parts: Map<string, { part: number; fullTitle: string }>): void {
  const groups = new Map<string, MediaItem[]>();
  for (const item of items) {
    if (!parts.has(item.id)) continue;
    const key = `${item.folder}|${item.title.toLowerCase()}|${item.year ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const group of groups.values()) {
    if (new Set(group.map((i) => parts.get(i.id)!.part)).size < 2) {
      // "Rocky Part 2" on its own is the movie's name, not a piece of it.
      for (const item of group) item.title = parts.get(item.id)!.fullTitle;
      continue;
    }
    group.sort((a, b) => parts.get(a.id)!.part - parts.get(b.id)!.part);
    const ids = group.map((i) => i.id);
    group.forEach((item, n) => (item.part = { index: n + 1, ids }));
  }
}

/**
 * Points each extra at what it belongs to: the one movie in its owner folder, or else the show whose episodes are
 * under that folder. Extras that match neither stay as they are, labeled by kind.
 */
export function linkExtras(items: MediaItem[], extras: Map<string, { kind: string; ownerFolder: string }>): void {
  for (const item of items) {
    const found = extras.get(item.id);
    if (!found) continue;
    const owner = found.ownerFolder;
    const movies = items.filter((i) => i.folder === owner && !i.episode && !extras.has(i.id) && !(i.part && i.part.index > 1));
    const under = (i: MediaItem) => owner === "" || i.folder === owner || i.folder.startsWith(owner + "/");
    const shows = [...new Set(items.filter((i) => i.episode && under(i)).map((i) => i.episode!.show))];
    const extra: ExtraInfo = {
      kind: found.kind,
      of: movies.length === 1 ? movies[0].id : null,
      show: movies.length !== 1 && shows.length === 1 && owner !== "" ? shows[0] : null,
    };
    item.extra = extra;
  }
}

export function mediaId(rootIndex: number, relPath: string): string {
  return crypto.createHash("sha1").update(`${rootIndex}:${relPath}`).digest("hex").slice(0, 16);
}

/**
 * Matches sidecar subtitles: for "Movie.mp4", accepts "Movie.srt", "Movie.en.srt",
 * "Movie.en.forced.vtt". Returns the tag between the base name and extension.
 */
export function subtitleTag(videoFile: string, candidate: string): string | null {
  const ext = path.extname(candidate).toLowerCase();
  if (!SUBTITLE_EXTS.has(ext)) return null;
  const videoBase = path.basename(videoFile, path.extname(videoFile));
  const subBase = path.basename(candidate, path.extname(candidate));
  if (subBase === videoBase) return "";
  if (subBase.startsWith(videoBase + ".")) return subBase.slice(videoBase.length + 1);
  return null;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`library: cannot read ${dir}: ${(err as Error).message}`);
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile()) out.push(full);
  }
}

export class Library {
  private entries = new Map<string, LibraryEntry>();
  private lastScan = 0;
  private scanning: Promise<void> | null = null;

  constructor(
    private roots: string[],
    private maxAgeMs = 60_000,
  ) {}

  async scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    const next = new Map<string, LibraryEntry>();
    const extraOwners = new Map<string, { kind: string; ownerFolder: string }>();
    const partNumbers = new Map<string, { part: number; fullTitle: string }>();
    for (const [rootIndex, root] of this.roots.entries()) {
      const files: string[] = [];
      await walk(root, files);

      const byDir = new Map<string, string[]>();
      for (const f of files) {
        const d = path.dirname(f);
        if (!byDir.has(d)) byDir.set(d, []);
        byDir.get(d)!.push(f);
      }

      for (const f of files) {
        const mime = VIDEO_TYPES[path.extname(f).toLowerCase()];
        if (!mime) continue;
        const stat = await fs.stat(f).catch(() => null);
        if (!stat) continue;

        const relPath = path.relative(root, f).split(path.sep).join("/");
        const folder = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";

        const subtitlePaths: string[] = [];
        const subtitles: SubtitleTrack[] = [];
        for (const sibling of byDir.get(path.dirname(f))!.sort()) {
          const tag = subtitleTag(f, sibling);
          if (tag === null) continue;
          // "Movie.en.forced.srt": a language, then anything else ("forced", "sdh") for the label.
          const [lang = null, ...rest] = tag ? tag.split(".") : [];
          const forced = rest.some((r) => r.toLowerCase() === "forced");
          const extra = rest.filter((r) => r.toLowerCase() !== "forced").join(" ");
          subtitles.push({ index: subtitlePaths.length, label: tag ? subtitleLabel(lang, extra, forced) : "Default", lang });
          subtitlePaths.push(sibling);
        }

        const id = mediaId(rootIndex, relPath);
        const { title, year, episode, extra, part, fullTitle } = parseName(relPath);
        if (extra) extraOwners.set(id, extra);
        if (part) partNumbers.set(id, { part, fullTitle: fullTitle ?? title });
        // A copied file keeps its old modified time but gets a new created time, so the later of the two is
        // when it landed in the library.
        const addedAt = Math.round(Math.max(stat.mtimeMs, stat.birthtimeMs || 0));
        next.set(id, {
          absPath: f,
          subtitlePaths,
          item: { id, title, relPath, folder, size: stat.size, mime, subtitles, addedAt, year, episode },
        });
      }
    }
    const all = [...next.values()].map((e) => e.item);
    linkParts(all, partNumbers);
    findFolderExtras(all, extraOwners);
    nameFromFolder(all, extraOwners);
    linkExtras(all, extraOwners);
    this.entries = next;
    this.lastScan = Date.now();
  }

  private async fresh(): Promise<void> {
    if (Date.now() - this.lastScan > this.maxAgeMs) await this.scan();
  }

  async list(): Promise<MediaItem[]> {
    await this.fresh();
    return [...this.entries.values()]
      .map((e) => e.item)
      .sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true, sensitivity: "base" }));
  }

  /** Looks up an entry, rescanning once if it is unknown (e.g. a file just added). */
  async get(id: string): Promise<LibraryEntry | undefined> {
    await this.fresh();
    if (!this.entries.has(id)) await this.scan();
    return this.entries.get(id);
  }

  /** Synchronous lookup against the last scan, for room messages. */
  peek(id: string): LibraryEntry | undefined {
    return this.entries.get(id);
  }
}
