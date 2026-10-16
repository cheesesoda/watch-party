import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IceServer } from "../../shared/protocol.ts";
import { DEFAULT_ICE_SERVERS } from "./rooms.ts";
import type { MetadataConfig } from "./metadata.ts";
import type { TranscodeConfig } from "./transcode.ts";

export interface Config {
  port: number;
  host: string;
  /** Absolute paths of the folders to index. */
  mediaDirs: string[];
  /** Shared password; empty disables auth (only allowed with ALLOW_NO_PASSWORD=1). */
  password: string;
  allowNoPassword: boolean;
  /** Built web client to serve, if present. */
  webDir: string;
  /** STUN/TURN servers handed to clients for voice chat. */
  iceServers: IceServer[];
  /**
   * Which proxies' X-Forwarded-For to believe, in Express "trust proxy" syntax. The login rate
   * limit is per client address, so behind a proxy like `tailscale serve` it must see the real one.
   */
  trustProxy: string;
  /** ffmpeg settings for converting files browsers can't play; left out, converting is off. */
  transcode?: TranscodeConfig;
  /**
   * The Android app's signing certificate SHA-256 fingerprints, so a phone opens the TV sign-in link
   * (/pair/…) in the app instead of the browser. Empty: the link always opens the web page.
   */
  androidApp?: { packageName: string; certFingerprints: string[] };
  /** Movie and episode details from TMDB; off without a TMDB token or key. */
  metadata?: MetadataConfig;
  /** Where "Pick up where you left off" spots are kept; left out, they're forgotten on restart. */
  spotsFile?: string;
  /** Where found intros and credits are kept (data/markers.json). */
  markersFile?: string;
  /** Where skip times set by hand are kept (data/skip-times.json). */
  skipTimesFile?: string;
  /**
   * Where invite links point, e.g. https://tv.chzsda.com, when that address forwards /join/CODE to this server.
   * Empty: invite links use the address the page was opened on.
   */
  inviteUrl?: string;
  /**
   * The server's own public address (the ts.net one), for video, subtitles and posters when the pages are
   * served through a proxy on another address (app.tv.chzsda.com), so the video doesn't pass through it.
   */
  mediaUrl?: string;
  /**
   * Shared with that proxy. A request carrying it may say which visitor it's from, so sign-in limits apply
   * per friend rather than to the proxy as a whole.
   */
  proxyKey?: string;
}

/** Parses ICE_SERVERS, a JSON array of RTCIceServer objects (urls may be a string or an array). */
export function parseIceServers(raw: string | undefined): IceServer[] {
  if (!raw?.trim()) return DEFAULT_ICE_SERVERS;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error("ICE_SERVERS must be a JSON array, e.g. [{\"urls\":\"stun:stun.l.google.com:19302\"}]");
  }
  if (!Array.isArray(list)) throw new Error("ICE_SERVERS must be a JSON array.");
  return list.map((s: any) => {
    const urls = (Array.isArray(s?.urls) ? s.urls : [s?.urls]).filter((u: unknown) => typeof u === "string" && u);
    if (urls.length === 0) throw new Error("Each ICE_SERVERS entry needs urls.");
    const server: IceServer = { urls };
    if (typeof s.username === "string") server.username = s.username;
    if (typeof s.credential === "string") server.credential = s.credential;
    return server;
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // MEDIA_PATH is the name .env uses for Docker; accepting it lets a plain `npm start` share that file.
  const dirs = (env.MEDIA_DIRS ?? env.MEDIA_DIR ?? env.MEDIA_PATH ?? "./media")
    .split(/[,;]/)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => path.resolve(d));

  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    mediaDirs: dirs,
    password: env.WATCH_PASSWORD ?? "",
    allowNoPassword: env.ALLOW_NO_PASSWORD === "1",
    webDir: path.resolve(env.WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url))),
    iceServers: parseIceServers(env.ICE_SERVERS),
    trustProxy: env.TRUST_PROXY?.trim() || "loopback",
    androidApp: {
      packageName: env.ANDROID_PACKAGE?.trim() || "com.cheeseparty.app",
      certFingerprints: (env.ANDROID_CERT_SHA256 ?? "").split(/[\s,]+/).filter(Boolean),
    },
    metadata: {
      token: env.TMDB_TOKEN?.trim() || undefined,
      apiKey: env.TMDB_API_KEY?.trim() || undefined,
      language: env.TMDB_LANGUAGE?.trim() || "en-US",
      file: path.resolve(env.METADATA_FILE?.trim() || fileURLToPath(new URL("../../data/metadata.json", import.meta.url))),
    },
    spotsFile: path.resolve(env.SPOTS_FILE?.trim() || fileURLToPath(new URL("../../data/spots.json", import.meta.url))),
    markersFile: path.resolve(env.MARKERS_FILE?.trim() || fileURLToPath(new URL("../../data/markers.json", import.meta.url))),
    skipTimesFile: path.resolve(env.SKIP_TIMES_FILE?.trim() || fileURLToPath(new URL("../../data/skip-times.json", import.meta.url))),
    inviteUrl: env.INVITE_URL?.trim().replace(/\/+$/, "") || undefined,
    mediaUrl: env.MEDIA_URL?.trim().replace(/\/+$/, "") || undefined,
    proxyKey: env.PROXY_KEY?.trim() || undefined,
    transcode: {
      ffmpeg: env.FFMPEG_PATH?.trim() || "ffmpeg",
      ffprobe: env.FFPROBE_PATH?.trim() || "ffprobe",
      dir: path.resolve(env.TRANSCODE_DIR?.trim() || path.join(os.tmpdir(), "watch-party-transcode")),
      encoder: env.TRANSCODE_ENCODER?.trim() || "auto",
      durationsFile: path.resolve(env.DURATIONS_FILE?.trim() || fileURLToPath(new URL("../../data/durations.json", import.meta.url))),
    },
  };
}
