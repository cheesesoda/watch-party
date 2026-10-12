import type { MediaInfo, MediaItem, RoomSummary } from "../../shared/protocol.ts";

/** A TMDB movie or show the host can pick with Fix match. */
export type MatchCandidate = { tmdbId: number; title: string; year: number | null; overview: string | null; posterPath: string | null };

/** convert: the server can convert files browsers can't play as-is. details: TMDB lookups are on. */
export type LibraryResponse = { items: MediaItem[]; convert: boolean; details?: boolean };

export class Unauthorized extends Error {}

/** The host signed in with the password; a guest joined one party with its code. */
export type Me = { role: "host" } | { role: "guest"; room: string };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    credentials: "same-origin",
  });
  if (res.status === 401) throw new Unauthorized("Not signed in.");
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

/** Where invite links point; the server's INVITE_URL, or this page's own address. */
let inviteBase = location.origin;
export const loadInviteBase = () =>
  fetch("/api/health")
    .then((r) => r.json())
    .then((h: { inviteUrl?: string | null }) => {
      if (h.inviteUrl) inviteBase = h.inviteUrl;
    })
    .catch(() => {});
export const getInviteBase = () => inviteBase;

export const api = {
  me: () => call<Me>("/api/me"),
  /** Joins one party by its code. Viewers get a pass for that party; the host keeps their sign-in. */
  join: (code: string) =>
    call<{ room: RoomSummary }>("/api/join", { method: "POST", body: JSON.stringify({ code }) }).then((r) => r.room),
  login: (password: string) => call<{ token: string }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => call("/api/logout", { method: "POST" }),
  library: () => call<LibraryResponse>("/api/library"),
  rescan: () => call<LibraryResponse>("/api/library/rescan", { method: "POST" }),
  searchMatch: (kind: "movie" | "tv", q: string) =>
    call<{ results: MatchCandidate[] }>(`/api/metadata/search?kind=${kind}&q=${encodeURIComponent(q)}`).then((r) => r.results),
  /** Fix match: the TMDB movie or show for this video (for an episode, its whole show), or none. */
  setMatch: (id: string, tmdbId: number | null) =>
    call<LibraryResponse>(`/api/media/${id}/match`, { method: "POST", body: JSON.stringify({ tmdbId }) }),
  rooms: () => call<{ rooms: RoomSummary[] }>("/api/rooms").then((r) => r.rooms),
  room: (id: string) => call<{ room: RoomSummary }>(`/api/rooms/${encodeURIComponent(id)}`).then((r) => r.room),
  info: (id: string) => call<{ info: MediaInfo | null }>(`/api/media/${id}/info`).then((r) => r.info),
  /** Ends a party for everyone in it, without joining. Host only. */
  endRoom: (id: string, name: string) =>
    call(`/api/rooms/${encodeURIComponent(id)}/end`, { method: "POST", body: JSON.stringify({ name }) }),
  /** queue: a binge, the videos to play one after another from the first. */
  createRoom: (mediaId?: string, queue?: string[]) =>
    call<{ room: RoomSummary }>("/api/rooms", { method: "POST", body: JSON.stringify({ mediaId, queue }) }).then((r) => r.room),
};

export const streamUrl = (id: string) => `/api/media/${id}/stream`;
export const hlsUrl = (id: string) => `/api/media/${id}/hls/index.m3u8`;
/** A TMDB poster or still, passed through the server. TMDB paths start with "/". */
export const imageUrl = (path: string, size: "w92" | "w185" | "w342" | "w500" | "w300") => `/api/images/${size}${path}`;
export const subtitleUrl = (id: string, index: number) => `/api/media/${id}/subtitles/${index}.vtt`;

const NAME_KEY = "wp_name";
export function getName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode: name lasts for this page only */
  }
}
