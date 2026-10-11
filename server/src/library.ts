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
        next.set(id, {
          absPath: f,
          subtitlePaths,
          item: { id, title: titleFromFilename(f), relPath, folder, size: stat.size, mime, subtitles },
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
