import fsp from "node:fs/promises";
import type { MediaItem } from "../../shared/protocol.ts";
import type { Library } from "./library.ts";
import type { Transcoder } from "./transcode.ts";

/** Converts SubRip (.srt) text to WebVTT so browsers and ExoPlayer can use one format. */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

/** Which of [tracks] is English: one tagged English first, then one with no language; never a forced one. -1 if none. */
export function englishTrack(tracks: { lang: string | null; label: string }[]): number {
  return (
    tracks
      .map((t, i) => ({ i, rank: /forced/i.test(t.label) ? -1 : t.lang ? (/^(en|eng)\b/i.test(t.lang) ? 2 : -1) : /english/i.test(t.label) ? 2 : 1 }))
      .filter((t) => t.rank > 0)
      .sort((a, b) => b.rank - a.rank)[0]?.i ?? -1
  );
}

/** A video's English subtitles as text (SubRip or WebVTT): a file beside it first, else a text track inside it; null if none. */
export async function englishSubtitles(library: Library, transcoder: Transcoder, absPath: string, item: MediaItem): Promise<string | null> {
  const entry = library.peek(item.id);
  const side = englishTrack(item.subtitles);
  if (entry && side >= 0 && entry.subtitlePaths[side]) return fsp.readFile(entry.subtitlePaths[side], "utf8").catch(() => null);
  const probe = await transcoder.probe(absPath);
  const inside = probe ? englishTrack(probe.subtitles) : -1;
  return inside >= 0 ? transcoder.subtitle(absPath, inside) : null;
}
