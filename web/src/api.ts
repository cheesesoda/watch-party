import type { HealthReport, HistoryEntry, MediaInfo, MediaItem, PartyInvite, RoomSummary, ScheduledParty, SkipMarks, Spot, SubtitleSearch, WatchState } from "../../shared/protocol.ts";

/** A video's skip times: what the server found, and what the host set by hand over it (a kind left out is still found). */
export type SkipTimes = { found: SkipMarks; set: SkipMarks | null };

/** A TMDB movie or show the host can pick with Fix match. */
export type MatchCandidate = { tmdbId: number; title: string; year: number | null; overview: string | null; posterPath: string | null };

/** convert: the server can convert files browsers can't play as-is. details: TMDB lookups are on. */
export type LibraryResponse = { items: MediaItem[]; convert: boolean; details?: boolean };

export class Unauthorized extends Error {}

/** A scheduled party's code, used before the party opens: [invite] says when it starts. */
export class NotStarted extends Error {
  readonly invite: PartyInvite;
  constructor(message: string, invite: PartyInvite) {
    super(message);
    this.invite = invite;
  }
}

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
  if (res.status === 409 && body.invite) throw new NotStarted(body.error, body.invite);
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

/** Where invite links point; the server's INVITE_URL, or this page's own address. */
let inviteBase = location.origin;
/**
 * Where video, subtitles and posters load from: the server's MEDIA_URL when these pages come through the
 * app.tv.chzsda.com proxy, so the video goes straight from the host's PC. Empty: this page's own address.
 */
let mediaBase = "";
/** The sign-in token, added to media links on MEDIA_URL (the sign-in cookie only goes to this address). */
let mediaToken = "";
export const loadServerInfo = () =>
  fetch("/api/health")
    .then((r) => r.json())
    .then((h: { inviteUrl?: string | null; mediaUrl?: string | null }) => {
      if (h.inviteUrl) inviteBase = h.inviteUrl;
      if (h.mediaUrl && h.mediaUrl !== location.origin) mediaBase = h.mediaUrl;
    })
    .catch(() => {});
export const getInviteBase = () => inviteBase;
/** True when media loads from another address, so the player has to ask for it in CORS mode. */
export const mediaElsewhere = () => mediaBase !== "";
const media = (path: string) =>
  mediaBase ? `${mediaBase}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(mediaToken)}` : path;

export const api = {
  me: () =>
    call<Me & { token?: string | null }>("/api/me").then((me) => {
      mediaToken = me.token ?? "";
      return me;
    }),
  /** Joins one party by its code. Viewers get a pass for that party; the host keeps their sign-in. */
  join: (code: string) =>
    call<{ room: RoomSummary; token?: string | null }>("/api/join", { method: "POST", body: JSON.stringify({ code }) }).then((r) => {
      if (r.token) mediaToken = r.token;
      return r.room;
    }),
  login: (password: string) =>
    call<{ token: string }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }).then((r) => {
      mediaToken = r.token;
      return r;
    }),
  logout: () => call("/api/logout", { method: "POST" }),
  library: () => call<LibraryResponse>("/api/library"),
  rescan: () => call<LibraryResponse>("/api/library/rescan", { method: "POST" }),
  searchMatch: (kind: "movie" | "tv", q: string) =>
    call<{ results: MatchCandidate[] }>(`/api/metadata/search?kind=${kind}&q=${encodeURIComponent(q)}`).then((r) => r.results),
  /** Fix match: the TMDB movie or show for this video (for an episode, its whole show), or none. */
  setMatch: (id: string, tmdbId: number | null) =>
    call<LibraryResponse>(`/api/media/${id}/match`, { method: "POST", body: JSON.stringify({ tmdbId }) }),
  skipTimes: (id: string) => call<SkipTimes>(`/api/media/${id}/skip-times`),
  /** Sets skip times by hand; null for a kind means none. */
  setSkipTimes: (id: string, marks: SkipMarks) => call<SkipTimes>(`/api/media/${id}/skip-times`, { method: "PUT", body: JSON.stringify(marks) }),
  /** Back to the times the server found. */
  clearSkipTimes: (id: string) => call<SkipTimes>(`/api/media/${id}/skip-times`, { method: "DELETE" }),
  /** Find subtitles: English ones on OpenSubtitles for a video without any. */
  findSubtitles: (id: string) => call<SubtitleSearch>(`/api/find-subtitles/${id}`),
  /** Downloads one of findSubtitles' results; the library comes back with it on the video. */
  downloadSubtitles: (id: string, fileId: number) => call<LibraryResponse>(`/api/find-subtitles/${id}`, { method: "POST", body: JSON.stringify({ fileId }) }),
  rooms: () => call<{ rooms: RoomSummary[] }>("/api/rooms").then((r) => r.rooms),
  room: (id: string) => call<{ room: RoomSummary }>(`/api/rooms/${encodeURIComponent(id)}`).then((r) => r.room),
  info: (id: string) => call<{ info: MediaInfo | null }>(`/api/media/${id}/info`).then((r) => r.info),
  /** Ends a party for everyone in it, without joining. Host only. save: keep its spot under "Pick up where you left off". */
  endRoom: (id: string, name: string, save = false) =>
    call(`/api/rooms/${encodeURIComponent(id)}/end`, { method: "POST", body: JSON.stringify({ name, save }) }),
  /** queue: a binge, the videos to play one after another from the first. */
  /** solo: the host watching alone, with no code to share until they invite friends. */
  /** position: where in the video to start (Pick up, from History). */
  createRoom: (mediaId?: string, queue?: string[], solo = false, position?: number) =>
    call<{ room: RoomSummary }>("/api/rooms", { method: "POST", body: JSON.stringify({ mediaId, queue, solo, position }) }).then((r) => r.room),
  /** Mark as watched / not watched; answers each video's new mark (null when it has none). */
  markWatched: (ids: string[], watched: boolean) =>
    call<{ watch: Record<string, WatchState | null> }>("/api/watched", { method: "POST", body: JSON.stringify({ ids, watched }) }).then((r) => r.watch),
  /** Library health: files that won't play well. */
  health: () => call<HealthReport>("/api/library/health"),
  /** Every video played, newest first. */
  history: () => call<{ history: HistoryEntry[] }>("/api/history").then((r) => r.history),
  /** "Pick up where you left off": where parties stopped, newest first. */
  spots: () => call<{ spots: Spot[] }>("/api/spots").then((r) => r.spots),
  removeSpot: (id: string) => call(`/api/spots/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** A new party at a saved spot, with the rest lined up in Up next. The spot is used up. */
  /** Parties scheduled for later, soonest first. */
  scheduled: () => call<{ scheduled: ScheduledParty[] }>("/api/scheduled").then((r) => r.scheduled),
  /** Schedules a party for [at] (ms since epoch); its code works from now on. name: who's hosting, for the invite. */
  schedule: (ids: string[], at: number, name: string) =>
    call<{ scheduled: ScheduledParty; invite: PartyInvite }>("/api/scheduled", { method: "POST", body: JSON.stringify({ queue: ids, at, name }) }),
  cancelScheduled: (id: string) => call(`/api/scheduled/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Opens a scheduled party now, with the same code. */
  startScheduled: (id: string) => call<{ room: RoomSummary }>(`/api/scheduled/${encodeURIComponent(id)}/start`, { method: "POST" }).then((r) => r.room),
  /** What an invite link shows before its party opens; null once it's on (or for no party). No sign-in needed. */
  invite: (code: string) => call<{ invite: PartyInvite | null }>(`/api/invite/${encodeURIComponent(code)}`).then((r) => r.invite),
  startSpot: (id: string, solo = false) =>
    call<{ room: RoomSummary }>("/api/rooms", { method: "POST", body: JSON.stringify({ spot: id, solo }) }).then((r) => r.room),
};

export const streamUrl = (id: string) => media(`/api/media/${id}/stream`);
/** The server's converted copy; `light`: its lighter one for slow connections (720p); `audio`: another audio track. */
export const hlsUrl = (id: string, light = false, audio?: number) =>
  media(`/api/media/${id}/hls/${light ? "light/" : ""}index.m3u8${audio !== undefined ? `?audio=${audio}` : ""}`);
/** A TMDB poster or still, passed through the server. TMDB paths start with "/". */
export const imageUrl = (path: string, size: "w92" | "w185" | "w342" | "w500" | "w300" | "w780" | "w1280") => media(`/api/images/${size}${path}`);
/** A still from the video where a saved spot stopped, for videos without TMDB art (host only). */
export const spotFrameUrl = (id: string) => media(`/api/spots/${id}/frame.jpg`);
/** `index` is a sidecar file's number, or "e2" for the third subtitle track inside the video file. */
export const subtitleUrl = (id: string, index: number | string) => media(`/api/media/${id}/subtitles/${index}.vtt`);

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
