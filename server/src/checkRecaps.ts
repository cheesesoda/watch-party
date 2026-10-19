/**
 * Reads a library's subtitles for recaps and prints what it finds, changing nothing: to check finding recaps by
 * subtitles on real files before the server does it.
 *
 *   npx tsx src/checkRecaps.ts <media folder> [show name]
 *
 * FFMPEG and FFPROBE can name ffmpeg's tools when they aren't on the path.
 */
import type { MediaItem } from "../../shared/protocol.ts";
import { Library } from "./library.ts";
import { englishSubtitles } from "./subtitles.ts";
import { findSubtitleRecap, parseCues, type Cue } from "./subtitleRecaps.ts";
import { Transcoder } from "./transcode.ts";

const [dir, show] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: npx tsx src/checkRecaps.ts <media folder> [show name]");
  process.exit(1);
}
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const library = new Library([dir]);
const transcoder = new Transcoder({ ffmpeg: process.env.FFMPEG ?? "ffmpeg", ffprobe: process.env.FFPROBE ?? "ffprobe", dir: "", encoder: "off" });
await library.scan();
const episodes = (await library.list()).filter((i) => i.episode && !i.extra && i.episode.season > 0 && (!show || i.episode.show.toLowerCase().includes(show.toLowerCase())));
const seasons = new Map<string, MediaItem[]>();
for (const item of episodes) {
  const key = `${item.episode!.show}|${item.episode!.season}`;
  if (!seasons.has(key)) seasons.set(key, []);
  seasons.get(key)!.push(item);
}
const cues = new Map<string, Cue[] | null>();
const cuesOf = async (item: MediaItem) => {
  if (!cues.has(item.id)) {
    const text = await englishSubtitles(library, transcoder, library.peek(item.id)!.absPath, item).catch(() => null);
    cues.set(item.id, text ? parseCues(text) : null);
  }
  return cues.get(item.id)!;
};
for (const [key, list] of [...seasons.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
  list.sort((a, b) => a.episode!.episode - b.episode!.episode);
  const [name, season] = key.split("|");
  const previous = seasons.get(`${name}|${Number(season) - 1}`)?.sort((a, b) => a.episode!.episode - b.episode!.episode) ?? [];
  console.log(`${name} season ${season}`);
  for (const [i, item] of list.entries()) {
    const label = `  E${String(item.episode!.episode).padStart(2, "0")}`;
    const mine = await cuesOf(item);
    if (!mine) {
      console.log(`${label}: no English text subtitles`);
      continue;
    }
    const opener = mine.find((c) => c.start < 300 && /previously|last (time|week|season) on/.test(c.text));
    const earlier: Cue[][] = [];
    for (const e of i > 0 ? list.slice(0, i) : previous) {
      const c = await cuesOf(e);
      if (c) earlier.push(c);
    }
    const recap = findSubtitleRecap(mine, earlier);
    if (recap) console.log(`${label}: recap ${clock(recap.range.start)}-${clock(recap.range.end)} (${recap.matched} lines said before)`);
    else if (opener) console.log(`${label}: "${opener.text}" at ${clock(opener.start)}, but too few lines after it were said before`);
    else console.log(`${label}: no "Previously on" line`);
  }
}
process.exit(0);
