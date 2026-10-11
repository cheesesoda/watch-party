import path from "node:path";
import type { IceServer } from "../../shared/protocol.ts";
import { DEFAULT_ICE_SERVERS } from "./rooms.ts";

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
  const dirs = (env.MEDIA_DIRS ?? env.MEDIA_DIR ?? "./media")
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
    webDir: path.resolve(env.WEB_DIR ?? new URL("../../web/dist", import.meta.url).pathname),
    iceServers: parseIceServers(env.ICE_SERVERS),
  };
}
