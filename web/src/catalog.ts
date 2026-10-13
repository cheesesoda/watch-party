import type { MediaItem, MediaMeta } from "../../shared/protocol.ts";

export const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** 7260 -> "2 h 1 m", 3000 -> "50 m": for summary lines, where a clock reads oddly. */
export function fmtRuntime(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${Math.max(1, m)} m`;
}

export interface Show {
  /** Stable for links: the TMDB id when known, or the folder's name. */
  key: string;
  name: string;
  /** The show names read from file names that were grouped into this one. */
  aliases: string[];
  episodes: MediaItem[];
  seasons: number[];
  addedAt: number;
  /** The show's TMDB details, from any of its episodes. */
  meta: MediaMeta | null;
  /** Behind the scenes, trailers… found in the show's folders. */
  extras: MediaItem[];
}

export interface Catalog {
  byId: Map<string, MediaItem>;
  /** Everything that isn't an episode, an extra that belongs to something, or a later part of a split movie. */
  movies: MediaItem[];
  shows: Show[];
  /** A movie's extras, by the movie's id. */
  movieExtras: Map<string, MediaItem[]>;
}

/** Extras (behind the scenes, trailers…) that belong to a movie or show are listed under it, not on their own. */
export const isOwnedExtra = (i: MediaItem) => !!(i.extra && (i.extra.of || i.extra.show));
/** A movie split into files ("Pt 1", "Pt 2") is listed once, as its first part, and plays all of them. */
export const isLaterPart = (i: MediaItem) => !!i.part && i.part.index > 1;

/** Groups the library into movies and shows, with their extras. */
export function buildCatalog(items: MediaItem[]): Catalog {
  const movieExtras = new Map<string, MediaItem[]>();
  const extrasByFolder = new Map<string, MediaItem[]>();
  for (const i of items) {
    const key = i.extra?.of ?? i.extra?.show;
    if (!key) continue;
    const map = i.extra!.of ? movieExtras : extrasByFolder;
    map.set(key, [...(map.get(key) ?? []), i].sort((a, b) => byName(a.title, b.title)));
  }

  const map = new Map<string, Show>();
  for (const item of items) {
    if (!item.episode) continue;
    // With TMDB, "Franklin & Bash" and "Franklin and Bash" folders are one show, under TMDB's name.
    const id = item.meta?.tmdbId ? `tmdb-${item.meta.tmdbId}` : item.episode.show.toLowerCase().replace(/\s*&\s*/g, " and ");
    if (!map.has(id)) map.set(id, { key: id, name: item.meta?.show ?? item.episode.show, aliases: [], episodes: [], seasons: [], addedAt: 0, meta: null, extras: [] });
    const show = map.get(id)!;
    if (!show.aliases.includes(item.episode.show)) show.aliases.push(item.episode.show);
    show.episodes.push(item);
    show.addedAt = Math.max(show.addedAt, item.addedAt ?? 0);
    show.meta ??= item.meta ?? null;
  }
  for (const show of map.values()) {
    show.episodes.sort((a, b) => a.episode!.season - b.episode!.season || a.episode!.episode - b.episode!.episode);
    show.seasons = [...new Set(show.episodes.map((e) => e.episode!.season))];
    show.extras = show.aliases.flatMap((a) => extrasByFolder.get(a) ?? []);
  }

  return {
    byId: new Map(items.map((i) => [i.id, i])),
    movies: items.filter((i) => !i.episode && !isOwnedExtra(i) && !isLaterPart(i)),
    shows: [...map.values()].sort((a, b) => byName(a.name, b.name)),
    movieExtras,
  };
}

/** A split movie's whole length, once every part's is known. */
export function partsLength(item: MediaItem, byId: Map<string, MediaItem>): number | null {
  const parts = (item.part?.ids ?? [item.id]).map((id) => byId.get(id));
  return parts.every((p) => p?.duration) ? parts.reduce((n, p) => n + p!.duration!, 0) : null;
}
