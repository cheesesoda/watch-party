import type { MediaInfo, MediaItem, RoomSummary } from "../../shared/protocol.ts";

/** convert: the server can convert files browsers can't play as-is. */
export type LibraryResponse = { items: MediaItem[]; convert: boolean };

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

export const api = {
  me: () => call<Me>("/api/me"),
  /** Joins one party by its code. Viewers get a pass for that party; the host keeps their sign-in. */
  join: (code: string) =>
    call<{ room: RoomSummary }>("/api/join", { method: "POST", body: JSON.stringify({ code }) }).then((r) => r.room),
  login: (password: string) => call<{ token: string }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => call("/api/logout", { method: "POST" }),
  library: () => call<LibraryResponse>("/api/library"),
  rescan: () => call<LibraryResponse>("/api/library/rescan", { method: "POST" }),
  rooms: () => call<{ rooms: RoomSummary[] }>("/api/rooms").then((r) => r.rooms),
  room: (id: string) => call<{ room: RoomSummary }>(`/api/rooms/${encodeURIComponent(id)}`).then((r) => r.room),
  info: (id: string) => call<{ info: MediaInfo | null }>(`/api/media/${id}/info`).then((r) => r.info),
  /** Ends a party for everyone in it, without joining. Host only. */
  endRoom: (id: string, name: string) =>
    call(`/api/rooms/${encodeURIComponent(id)}/end`, { method: "POST", body: JSON.stringify({ name }) }),
  createRoom: (mediaId?: string) =>
    call<{ room: RoomSummary }>("/api/rooms", { method: "POST", body: JSON.stringify({ mediaId }) }).then((r) => r.room),
};

export const streamUrl = (id: string) => `/api/media/${id}/stream`;
export const hlsUrl = (id: string) => `/api/media/${id}/hls/index.m3u8`;
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
