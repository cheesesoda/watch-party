import type { MediaItem } from "./protocol.ts";

/** A show's episodes in watching order, with its specials (season 0) where they aired. */
export interface Woven {
  /** Every episode: the seasons in order with the dated specials woven in, then specials TMDB has no date for. */
  all: MediaItem[];
  /** Each season (not 0) with the specials that aired during it, in order. */
  seasons: Map<number, MediaItem[]>;
  /** Season 0 alone, by number: the Specials tab. */
  specials: MediaItem[];
}

const num = (e: MediaItem) => e.episode!;

/** "S2 E3", or "Special 3" for season 0. */
export const episodeLabel = (season: number, episode: number) => (season === 0 ? `Special ${episode}` : `S${season} E${episode}`);

/**
 * Places each special after the last episode that aired on or before its air date (TMDB's), so a binge plays it
 * where people first saw it. One that aired before the first episode starts that season; one without a date, or in a
 * show whose episodes have none, only goes at the end of the whole binge.
 */
export function weave(episodes: MediaItem[]): Woven {
  const regular = episodes.filter((e) => num(e).season > 0).sort((a, b) => num(a).season - num(b).season || num(a).episode - num(b).episode);
  const specials = episodes.filter((e) => num(e).season === 0).sort((a, b) => num(a).episode - num(b).episode);
  const after = new Map<number, MediaItem[]>(); // index into regular, -1 for before the first
  const undated: MediaItem[] = [];
  const dated = regular.some((e) => e.meta?.airDate);
  for (const s of specials) {
    const day = s.meta?.airDate;
    if (!day || !dated || !regular.length) {
      undated.push(s);
      continue;
    }
    let at = -1;
    regular.forEach((e, i) => {
      if (e.meta?.airDate && e.meta.airDate <= day) at = i;
    });
    after.set(at, [...(after.get(at) ?? []), s]);
  }
  const all: MediaItem[] = [...(after.get(-1) ?? [])];
  const seasons = new Map<number, MediaItem[]>();
  const add = (n: number, list: MediaItem[]) => seasons.set(n, [...(seasons.get(n) ?? []), ...list]);
  if (regular.length) add(num(regular[0]).season, after.get(-1) ?? []);
  regular.forEach((e, i) => {
    const next = [e, ...(after.get(i) ?? [])];
    all.push(...next);
    add(num(e).season, next);
  });
  all.push(...undated);
  return { all, seasons, specials };
}
