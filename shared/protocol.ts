// Wire types shared by the server and the web client.
// The Android app mirrors these in android/app/src/main/java/.../Protocol.kt;
// keep the two in sync when changing anything here.

export interface SubtitleTrack {
  index: number;
  label: string;
  lang: string | null;
}

export interface MediaItem {
  id: string;
  title: string;
  /** Path relative to its library root, using forward slashes. */
  relPath: string;
  /** Folder portion of relPath ("" for files at the root). */
  folder: string;
  size: number;
  mime: string;
  subtitles: SubtitleTrack[];
  /** When the file landed in the library, ms since epoch. */
  addedAt?: number;
  /** Release year read from the file name, e.g. "Alien (1979).mkv". */
  year?: number | null;
  /** Seconds, once the server has read the file with ffprobe; null or missing until then. */
  duration?: number | null;
  /** Set when the file name looks like a TV episode ("Show.S02E04.Title.mkv"). */
  episode?: EpisodeInfo | null;
  /** Set for bonus material (behind the scenes, trailers, deleted scenes…) named the way Plex expects. */
  extra?: ExtraInfo | null;
  /** Details from TMDB (themoviedb.org), when the server has a TMDB key and found a match. */
  meta?: MediaMeta | null;
  /** One piece of a movie split into files ("Grindhouse (2007) Pt 1.mp4"): which one, and the ids of all of them in order. */
  part?: PartInfo | null;
  /** Where its intro, recap and credits are, once the server has looked (see SkipMarks). */
  marks?: SkipMarks | null;
  /** Whether it was watched, or how far in it got (in the library list; see WatchState). */
  watch?: WatchState | null;
}

/** A video's watched mark, kept for everyone on the server. */
export interface WatchState {
  /** When it was watched to the credits, or marked watched (ms since epoch); null if it hasn't been. */
  watchedAt: number | null;
  /** How far in the last time it played (seconds), when it stopped before the credits; null if not. */
  position: number | null;
  updatedAt: number;
}

/**
 * Parts of a video people skip, in seconds. Intros and credits are found by comparing the sound of a season's
 * episodes; recaps (and anything else) come from the file's chapter names ("Recap", "Intro", "Credits").
 */
export interface SkipMarks {
  intro?: TimeRange | null;
  recap?: TimeRange | null;
  /** Where the credits start; Up next comes up there. */
  credits?: number | null;
}

export interface TimeRange {
  start: number;
  end: number;
}

export interface PartInfo {
  /** 1-based. */
  index: number;
  /** Every part's id, in order, so a client can play them back to back. */
  ids: string[];
}

/** Movie or episode details from TMDB. Image paths go after a TMDB image base, e.g. https://image.tmdb.org/t/p/w342. */
export interface MediaMeta {
  /** The movie's TMDB id, or the show's for an episode. */
  tmdbId: number;
  /** The movie's title, or the episode's name. */
  title: string;
  /** Release year, or the show's first year. */
  year: number | null;
  overview: string | null;
  /** Movie poster, or the season's (falling back to the show's) for an episode. */
  posterPath: string | null;
  /** The episode's still image. */
  stillPath?: string | null;
  /** When the episode first aired, "2019-12-25" (TMDB), so specials can be played where they aired. */
  airDate?: string | null;
  /** The show's name as TMDB has it, for episodes. */
  show?: string | null;
  /** The show's own poster and summary, for episodes. */
  showPosterPath?: string | null;
  showOverview?: string | null;
  /** Wide background art: the movie's, or the show's for an episode. */
  backdropPath?: string | null;
  /** TMDB's average score out of 10 (the show's for an episode). */
  rating?: number | null;
  /** "Comedy", "Crime"… (the show's for an episode). */
  genres?: string[];
}

export interface ExtraInfo {
  /** "Behind the scenes", "Trailer", "Deleted scene"… */
  kind: string;
  /** The movie it belongs to: the one video in the same folder (or the folder above an extras folder). */
  of: string | null;
  /** Or the TV show it belongs to, when its folder holds a show's episodes. */
  show: string | null;
}

export interface EpisodeInfo {
  show: string;
  season: number;
  episode: number;
  /** The episode's own title, when the file name has one. */
  title: string | null;
}

/** What ffprobe found in a file, so a browser can tell whether it can play it as-is. */
export interface MediaInfo {
  /** ffprobe's format name, e.g. "matroska,webm" or "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string;
  /** Seconds. */
  duration: number;
  video: { codec: string; width: number; height: number; pixFmt: string } | null;
  audio: { codec: string; channels: number } | null;
  /**
   * The track to play (English when the file has it) isn't the file's first audio track. Browsers play the first one
   * and can't switch, so they need the converted copy, which carries the right one.
   */
  audioNotFirst?: boolean;
  /** The server can convert this file for browsers (ffmpeg is installed). */
  convert: boolean;
  /** Text subtitles inside the file, which the server serves as WebVTT (picture-based ones are left out). */
  subtitles: SubtitleTrack[];
}

export interface PlaybackState {
  mediaId: string | null;
  paused: boolean;
  /** Playback position in seconds at `updatedAt`. */
  position: number;
  /** Server clock (ms since epoch) when `position` was recorded. */
  updatedAt: number;
  /**
   * Paused only until every screen has loaded the spot someone jumped to; then everyone plays together.
   * Screens answer with a "ready" message once they have.
   */
  hold?: boolean;
}

export interface Member {
  id: string;
  name: string;
  /** In the room's voice chat. */
  voice: boolean;
  /** Not sending audio: muted, or listening only (no mic). */
  muted: boolean;
  /** What they joined from, so a phone can act as the chat screen for its owner's TV. */
  device: Device;
}

export type Device = "web" | "phone" | "tv";

/** An RTCIceServer, with `urls` always an array so typed clients can parse it. */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** WebRTC negotiation data, relayed between two voice members as-is. */
export type SignalData =
  | { sdp: { type: "offer" | "answer"; sdp: string } }
  | { candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } };

export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  ts: number;
  /** True for join/leave/playback notices generated by the server. */
  system?: boolean;
}

/**
 * Up next: the videos the party plays one after another (including the ones already played and the one playing now),
 * and the switch to the next one if it's coming up. Binge fills it; the host can add, remove and reorder what's next.
 */
export interface Queue {
  items: MediaItem[];
  /** Which of [items] is playing now; the ones after it are Up next. -1 when nothing in it is playing. */
  at?: number;
  /** Counting down to the next video: which one, and when it starts (server clock, ms). */
  advance: { mediaId: string; at: number } | null;
}

export interface RoomSummary {
  id: string;
  media: MediaItem | null;
  members: Member[];
  /** Set for a binge: where the party is in it, e.g. 3 of 10. */
  binge?: { index: number; length: number } | null;
  /** The next video in Up next, and how many there are in all after the one playing now. */
  upNext?: { item: MediaItem; count: number } | null;
  /** Where the party is in its video, for the host's party list. Only on the room list and room lookups. */
  playback?: RoomPlayback;
  /** The host watching alone: no code to share, no chat or voice, until they invite friends. */
  solo?: boolean;
}

/** Where a party stopped, saved so a new party can pick up there ("Pick up where you left off"). */
export interface Spot {
  id: string;
  /** The video to start, and how far into it (seconds). */
  media: MediaItem;
  position: number;
  /** What was still lined up after it, in order. */
  next: MediaItem[];
  /** When it was saved (ms since epoch). */
  savedAt: number;
}

/** One video played in one party (or Watch alone), for History. */
export interface Play {
  id: string;
  mediaId: string;
  /** When it started and when it last played (ms since epoch). */
  startedAt: number;
  lastAt: number;
  /** Where it was the last time it played (seconds). */
  position: number;
  /** Everyone who was there. */
  names: string[];
  /** Watched alone the whole time. */
  solo: boolean;
  /** It reached the credits. */
  watched: boolean;
}

/** A play with its video, as History lists it. */
export interface HistoryEntry extends Play {
  media: MediaItem;
}

export interface RoomPlayback {
  /** Seconds into the video when the server answered. */
  position: number;
  paused: boolean;
  /** Seconds; null when ffprobe couldn't read the file. */
  duration: number | null;
}

export type ClientMessage =
  /** `at`: the server's clock when it happened on the sender, so friends don't fall behind by the sender's lag. */
  | { type: "play"; position: number; at?: number }
  | { type: "pause"; position: number; at?: number }
  /** `skip`: the jump was Skip intro or Skip recap, so friends see "Jake skipped the intro". */
  | { type: "seek"; position: number; at?: number; skip?: "intro" | "recap" }
  /**
   * This screen has loaded `position` during a hold (see PlaybackState.hold). `late`: the hold had already given up on
   * it, and it has now caught up (for the log). `converted`: it plays the server's converted copy; `light`: its
   * lighter copy for slow connections.
   */
  | { type: "ready"; position: number; late?: boolean; converted?: boolean; light?: boolean }
  /** This screen changed its video quality (for the log). `auto`: by itself, after waiting for video too often. */
  | { type: "quality"; light: boolean; auto?: boolean }
  /** This member's screen plays the video (false for a phone that's only for chat). Holds wait for these screens. */
  | { type: "player"; on: boolean }
  | { type: "select"; mediaId: string }
  /** Host: play these one after another, starting with the first. */
  | { type: "binge"; mediaIds: string[] }
  /** A video finished playing on this member's screen, or reached its credits; in a binge, the next one comes up. */
  | { type: "ended"; mediaId: string }
  /** Don't move on to the next video in the binge (Stay here). Anyone can. */
  | { type: "cancel-advance" }
  /** Play the video Up next is counting down to now (Play now). Anyone can. */
  | { type: "advance-now" }
  /** Host: add these to the end of Up next (when nothing is playing, the first one is picked). */
  | { type: "queue-add"; mediaIds: string[] }
  /** Host: take this video out of Up next. */
  | { type: "queue-remove"; mediaId: string }
  /** Host: move this video to place [to] in Up next (0 = next). */
  | { type: "queue-move"; mediaId: string; to: number }
  /** Host: empty Up next (the video playing now keeps playing). */
  | { type: "queue-clear" }
  | { type: "chat"; text: string }
  | { type: "ping"; clientTime: number }
  /** Join or leave voice, or change mute while in it. */
  | { type: "voice"; on: boolean; muted: boolean }
  | { type: "signal"; to: string; data: SignalData }
  /** Ends the party for everyone. `save`: keep its spot on Home under "Pick up where you left off". */
  | { type: "end"; save?: boolean }
  /** Host, watching alone: open it up as a party friends can join with its code. */
  | { type: "invite" };

export type ServerMessage =
  | {
      type: "welcome";
      you: Member;
      roomId: string;
      state: PlaybackState;
      media: MediaItem | null;
      members: Member[];
      chat: ChatMessage[];
      serverTime: number;
      iceServers: IceServer[];
      /** The binge, if the party has one. */
      queue?: Queue | null;
      /** The host is watching alone (see RoomSummary.solo). */
      solo?: boolean;
    }
  /** Watching alone became a party (after "invite"), so friends can join and chat and voice show up. */
  | { type: "solo"; solo: boolean }
  /** The binge changed: started, moved on, counting down to the next video, or stopped (null). */
  | { type: "queue"; queue: Queue | null }
  | { type: "state"; state: PlaybackState; media: MediaItem | null; by: string | null }
  | { type: "members"; members: Member[] }
  | { type: "chat"; message: ChatMessage }
  | { type: "pong"; clientTime: number; serverTime: number }
  /** Sent to a member who just joined voice: the members they should send offers to. */
  | { type: "voice-peers"; peers: string[] }
  | { type: "signal"; from: string; data: SignalData }
  /** The party is over; the server closes the connection (code 4404) right after. */
  | { type: "ended"; by: string }
  | { type: "error"; message: string };

/** Where playback should be right now, given a state and the current server time. */
export function expectedPosition(state: PlaybackState, serverNow: number): number {
  if (state.paused) return state.position;
  return state.position + Math.max(0, serverNow - state.updatedAt) / 1000;
}

/**
 * Close enough to the end that the video counts as watched: in its credits (when the server found where they start),
 * or the last minute, or the last 5% for long ones.
 */
export function nearEnd(position: number, duration: number | null | undefined, credits?: number | null): boolean {
  if (credits != null && position >= credits) return true;
  return !!duration && position >= duration - Math.max(60, duration * 0.05);
}

/**
 * Whether a party stopping here is worth picking up later: partway through a video (past the first minute and
 * not at the credits), or with more lined up after it.
 */
export function worthSaving(position: number, duration: number | null | undefined, upcoming: number, credits?: number | null): boolean {
  if (nearEnd(position, duration, credits)) return upcoming > 0;
  return position >= 60 || upcoming > 0;
}

/**
 * The intro or recap playing at [position], if any, and where it ends: Skip intro / Skip recap shows while it does.
 * Not in its last two seconds, when skipping saves nothing.
 */
export function skippable(marks: SkipMarks | null | undefined, position: number): { kind: "intro" | "recap"; to: number } | null {
  for (const kind of ["recap", "intro"] as const) {
    const part = marks?.[kind];
    if (part && position >= part.start && position < part.end - 2) return { kind, to: part.end };
  }
  return null;
}
