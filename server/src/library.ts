import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MediaItem, SubtitleTrack } from "../../shared/protocol.ts";

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
const JUNK = /^(\d{3,4}p|4k|uhd|hdr\d*|dv|bluray|blu-ray|bdrip|brrip|web|webrip|web-dl|webdl|hdtv|dvdrip|remux|x26[45]|h26[45]|hevc|avc|aac\d*|ac3|dts|ddp?\d*|atmos|10bit|proper|repack|extended|unrated|imax)$/i;

function clean(text: string): string {
  return text.replace(/[._]+/g, " ").replace(/\s+/g, " ").replace(/^[\s\-–·:]+|[\s\-–·:(\[]+$/g, "").trim();
}

/** Drops release tags from the first one onward: "Movie 1080p BluRay" -> "Movie". */
function untag(text: string): string {
  const words = clean(text).split(" ");
  const cut = words.findIndex((w, i) => i > 0 && JUNK.test(w.replace(/[()[\]]/g, "")));
  return clean((cut === -1 ? words : words.slice(0, cut)).join(" "));
}

export interface ParsedName {
  title: string;
  year: number | null;
  episode: { show: string; season: number; episode: number; title: string | null } | null;
}

/**
 * Reads a title, year and TV episode from a path like "Alien (1979).mkv", "The.Matrix.1999.1080p.mp4",
 * "Severance.S02E04.Woes.Hollow.mkv" or "Severance/Season 2/S02E04.mkv".
 */
export function parseName(relPath: string): ParsedName {
  const parts = relPath.split("/");
  const base = path.basename(parts[parts.length - 1], path.extname(parts[parts.length - 1]));
  const ep = base.match(/(?:^|[\s._\-[(])s(\d{1,2})[\s._-]?e(\d{1,3})(?:-?e\d{1,3})?(?=$|[\s._\-\])])/i) ?? base.match(/(?:^|[\s._-])(\d{1,2})x(\d{2,3})(?=$|[\s._-])/i);
  if (ep) {
    // "Doctor.Who.2005.S01E01": the year only tells shows with the same name apart, so it's dropped.
    let show = clean(untag(base.slice(0, ep.index! + (/^[\s._\-[(]/.test(ep[0]) ? 1 : 0))).replace(/\(?(19|20)\d{2}\)?$/, ""));
    if (!show) {
      // "Show/Season 2/S02E04.mkv": use the nearest folder that isn't a season folder.
      const folders = parts.slice(0, -1).reverse();
      show = clean(folders.find((f) => !/^(season|series|s)\s*\d+$/i.test(clean(f))) ?? "");
    }
    const season = Number(ep[1]);
    const episode = Number(ep[2]);
    const epTitle = untag(base.slice(ep.index! + ep[0].length)) || null;
    const name = show || titleFromFilename(base);
    return {
      title: `${name} S${season} E${episode}${epTitle ? ` · ${epTitle}` : ""}`,
      year: null,
      episode: { show: name, season, episode, title: epTitle },
    };
  }
  // The last 19xx/20xx that isn't the start of the name is the year, so "2001 A Space Odyssey 1968" works.
  const years = [...base.matchAll(/(?<=^|[\s._\-[(])((?:19|20)\d{2})(?=$|[\s._\-\])])/g)].filter((m) => m.index! > 0);
  const y = years[years.length - 1];
  if (y && Number(y[1]) <= new Date().getFullYear() + 1) {
    return { title: untag(base.slice(0, y.index!)) || titleFromFilename(base), year: Number(y[1]), episode: null };
  }
  return { title: untag(base) || titleFromFilename(base), year: null, episode: null };
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
          const lang = tag.split(".")[0] || null;
          subtitles.push({ index: subtitlePaths.length, label: tag.replace(/\./g, " ") || "Default", lang });
          subtitlePaths.push(sibling);
        }

        const id = mediaId(rootIndex, relPath);
        const { title, year, episode } = parseName(relPath);
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
