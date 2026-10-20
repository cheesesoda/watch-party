import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, HistoryEntry, MediaItem, RoomSummary, ServerMessage, Spot } from "../../shared/protocol.ts";
import type { IncomingMessage } from "node:http";
import { checkPassword, COOKIE_NAME, extractToken, guestToken, parseGuestToken, safeEqual, tokenFor, type Access } from "./auth.ts";
import type { Config } from "./config.ts";
import { Library } from "./library.ts";
import { Health } from "./health.ts";
import { handSet, Markers } from "./markers.ts";
import { Metadata } from "./metadata.ts";
import { parseRange } from "./range.ts";
import { FailureLimiter } from "./ratelimit.ts";
import { cleanName, MAX_QUEUE, RoomManager, type Room } from "./rooms.ts";
import { History } from "./history.ts";
import { Spots } from "./spots.ts";
import { srtToVtt } from "./subtitles.ts";
import { Transcoder } from "./transcode.ts";

export interface App {
  server: http.Server;
  library: Library;
  rooms: RoomManager;
  transcoder: Transcoder;
  metadata: Metadata;
  markers: Markers;
  /** Looks for intros and credits in files not looked at yet, in the background. */
  findMarks(): Promise<void>;
  close(): Promise<void>;
}

export function createApp(config: Config): App {
  const library = new Library(config.mediaDirs);
  const metadata = new Metadata(config.metadata ?? { language: "en-US", file: "" });
  const transcoder = new Transcoder(config.transcode ?? { ffmpeg: "ffmpeg", ffprobe: "ffprobe", dir: "", encoder: "off" });
  const markers = new Markers({ ffmpeg: config.transcode?.ffmpeg ?? "ffmpeg", ffprobe: config.transcode?.ffprobe ?? "ffprobe", file: config.markersFile ?? "", handFile: config.skipTimesFile ?? "" });
  // What parties play carries its intro and credits times, for Skip intro and the Up next card, and its length once
  // known, so a video without a credits mark still counts as watched near its end.
  const history = new History(config.historyFile);
  const health = new Health(config.healthFile, (file) => transcoder.probe(file));
  const rooms = new RoomManager((id) => {
    const entry = library.peek(id);
    if (!entry) return undefined;
    const duration = transcoder.knownDuration(entry.absPath);
    return markers.attach(metadata.enrich(duration ? { ...entry.item, duration } : entry.item));
  }, Date.now, undefined, config.iceServers, new Spots(config.spotsFile), history);
  const findMarks = async () => {
    const items = await library.list();
    const entries = items.map((item) => ({ absPath: library.peek(item.id)!.absPath, item })).filter((e) => e.absPath);
    // Library health first: it's quick (a header and a few spots per file), and finding marks takes hours on a new library.
    await health.check(entries).catch((e) => console.warn(`health: ${(e as Error).message}`));
    await markers.warm(entries);
  };
  // Videos added while the server runs get their details and skip times without a Rescan.
  library.onNew = () => {
    void library.list().then((items) => metadata.warm(items));
    void findMarks();
  };
  const app = express();
  app.disable("x-powered-by");

  // Behind the app.tv.chzsda.com proxy every request comes from the proxy, so it names the visitor instead.
  const clientOf = (req: express.Request): string => {
    const key = req.headers["x-popcorn-proxy-key"];
    const visitor = req.headers["x-popcorn-client"];
    if (config.proxyKey && typeof key === "string" && typeof visitor === "string" && visitor && checkPassword(config.proxyKey, key)) {
      return visitor.slice(0, 64);
    }
    return req.ip ?? "unknown";
  };
  app.set("trust proxy", config.trustProxy);
  // Large enough for a binge of a long show's every episode.
  app.use(express.json({ limit: "64kb" }));

  // Lets the Android app and other origins talk to the API.
  app.use("/api", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, authRequired: Boolean(config.password), inviteUrl: config.inviteUrl ?? null, mediaUrl: config.mediaUrl ?? null });
  });

  const hostToken = config.password ? tokenFor(config.password) : "";
  /** Who is asking: the host (signed in with the password), a guest of one party, or nobody. */
  const accessOf = (req: IncomingMessage): Access | null => {
    if (!config.password) return { kind: "host" };
    const token = extractToken(req);
    if (!token) return null;
    if (safeEqual(token, hostToken)) return { kind: "host" };
    const guest = parseGuestToken(token);
    const room = guest && rooms.get(guest.roomId);
    return room && safeEqual(guest.key, room.guestKey) ? { kind: "guest", roomId: room.id } : null;
  };

  const loginLimiter = new FailureLimiter();
  app.post("/api/login", (req, res) => {
    const client = clientOf(req);
    const wait = loginLimiter.blockedFor(client);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      return void res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.` });
    }
    if (config.password && !checkPassword(config.password, req.body?.password)) {
      loginLimiter.fail(client);
      return void res.status(401).json({ error: "Wrong password." });
    }
    loginLimiter.reset(client);
    const token = config.password ? tokenFor(config.password) : "";
    // Secure over HTTPS (tailscale serve/funnel says so in X-Forwarded-Proto), so the cookie never goes out over plain HTTP.
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 365 * 24 * 3600 * 1000 });
    res.json({ token });
  });

  // Viewers join one party with its code, no password. The pass stops working when the party ends.
  const joinLimiter = new FailureLimiter();
  app.post("/api/join", (req, res) => {
    const client = clientOf(req);
    const wait = joinLimiter.blockedFor(client);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      return void res.status(429).json({ error: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.` });
    }
    const code = req.body?.code;
    const room = typeof code === "string" && code.trim() ? rooms.joinable(code.trim()) : undefined;
    if (!room) {
      joinLimiter.fail(client);
      return void res.status(404).json({ error: "No party with that code. It may have ended." });
    }
    // The host keeps their own sign-in rather than trading it for a viewer pass.
    if (accessOf(req)?.kind === "host") return void res.json({ token: null, room: room.summary() });
    const token = guestToken(room.id, room.guestKey);
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 7 * 24 * 3600 * 1000 });
    res.json({ token, room: room.summary() });
  });

  // Signing in a TV from a phone: the TV asks for a pairing and shows it as a QR code; the phone opens
  // /pair/<id>, enters a party code (or the password), and the TV picks up the pass on its next poll.
  const PAIR_MS = 10 * 60_000;
  const pairings = new Map<string, { expires: number; result?: Record<string, unknown> }>();
  const pairLimiter = new FailureLimiter(20);
  const pending = (id: string) => {
    const p = pairings.get(id);
    if (p && p.expires > Date.now()) return p;
    pairings.delete(id);
    return undefined;
  };

  app.post("/api/pair", (req, res) => {
    const client = clientOf(req);
    if (pairLimiter.blockedFor(client) > 0 || pairings.size >= 500) {
      return void res.status(429).json({ error: "Too many sign-in codes. Try again in a few minutes." });
    }
    pairLimiter.fail(client);
    const id = crypto.randomBytes(18).toString("base64url");
    pairings.set(id, { expires: Date.now() + PAIR_MS });
    res.status(201).json({ id, expiresIn: PAIR_MS / 1000 });
  });

  app.get("/api/pair/:id", (req, res) => {
    const p = pending(req.params.id);
    if (!p) return void res.status(404).json({ error: "This sign-in code expired. Show a new one." });
    if (!p.result) return void res.json({ status: "waiting" });
    pairings.delete(req.params.id);
    res.json({ status: "done", ...p.result });
  });

  app.post("/api/pair/:id", (req, res) => {
    const p = pending(req.params.id);
    if (!p || p.result) return void res.status(404).json({ error: "This sign-in code expired. Show a new one on the TV." });
    const client = clientOf(req);
    const name = cleanName(req.body?.name);
    const code = req.body?.code;

    if (typeof code === "string" && code.trim()) {
      const wait = joinLimiter.blockedFor(client);
      if (wait > 0) return void res.status(429).json({ error: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.` });
      const room = rooms.joinable(code.trim());
      if (!room) {
        joinLimiter.fail(client);
        return void res.status(404).json({ error: "No party with that code. It may have ended." });
      }
      p.result = { role: "guest", token: guestToken(room.id, room.guestKey), room: room.id, name };
      return void res.json({ ok: true });
    }

    // The host: already signed in on this phone, or types the password.
    if (accessOf(req)?.kind !== "host") {
      const wait = loginLimiter.blockedFor(client);
      if (wait > 0) return void res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.` });
      if (!checkPassword(config.password, req.body?.password)) {
        loginLimiter.fail(client);
        return void res.status(401).json({ error: "Wrong password." });
      }
    }
    p.result = { role: "host", token: hostToken, name };
    res.json({ ok: true });
  });

  app.post("/api/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
  });

  app.use("/api", (req, res, next) => {
    const access = accessOf(req);
    if (!access) return void res.status(401).json({ error: "Not signed in." });
    res.locals.access = access;
    next();
  });

  app.get("/api/me", (req, res) => {
    const access: Access = res.locals.access;
    // The token goes in video and poster links when those load straight from MEDIA_URL (another address,
    // so the sign-in cookie isn't sent there).
    const token = extractToken(req);
    res.json(access.kind === "host" ? { ok: true, role: "host", token } : { ok: true, role: "guest", room: access.roomId, token });
  });

  // Guests only get what their own party is playing.
  app.use("/api/media/:id", (req, res, next) => {
    const access: Access = res.locals.access;
    if (access.kind === "host" || rooms.get(access.roomId)?.media?.id === req.params.id) return next();
    res.status(403).json({ error: "That isn't playing in your party." });
  });
  app.get("/api/rooms/:id", (req, res, next) => {
    const access: Access = res.locals.access;
    if (access.kind === "host" || rooms.get(req.params.id)?.id === access.roomId) return next();
    res.status(403).json({ error: "You can only see the party you joined." });
  });
  // Everything else (the library, the list of parties, starting one) is for the host. Guests also get posters and stills
  // (TMDB's artwork, nothing from the library itself), for the thumbnails in Up next.
  app.use("/api", (req, res, next) => {
    const access: Access = res.locals.access;
    if (access.kind === "host" || /^\/(media|rooms|images)\/[^/]+/.test(req.path)) return next();
    res.status(403).json({ error: "Only the host can do that. Ask them for the password." });
  });

  // convert: the server can turn any file into something browsers play (ffmpeg is installed).
  // details: TMDB lookups are on, so the host can fix a wrong match.
  const libraryResponse = async () => ({
    items: withDurations(await library.list()).map((item) => withWatch(metadata.enrich(item))),
    convert: (await transcoder.encoderName()) !== null,
    details: metadata.enabled,
  });

  const withWatch = (item: MediaItem): MediaItem => {
    const watch = history.state(item.id);
    return watch ? { ...item, watch } : item;
  };

  // Lengths come from ffprobe, which takes a moment per file, so they're read one file at a time in the
  // background. They're kept in data/durations.json, so after a restart they show straight away.
  const queued = new Set<string>();
  let probing: Promise<unknown> = Promise.resolve();
  const withDurations = (items: MediaItem[]): MediaItem[] =>
    items.map((item) => {
      const entry = library.peek(item.id);
      if (!entry) return item;
      if (transcoder.cachedDuration(entry.absPath) === undefined && !queued.has(entry.absPath)) {
        queued.add(entry.absPath);
        probing = probing.then(() => transcoder.probe(entry.absPath)).catch(() => null);
      }
      const duration = transcoder.knownDuration(entry.absPath);
      return duration ? { ...item, duration } : item;
    });

  app.get("/api/library", async (_req, res) => {
    res.json(await libraryResponse());
  });

  app.get("/api/library/health", (_req, res) => {
    res.json(health.report());
  });

  app.post("/api/library/rescan", async (_req, res) => {
    await library.scan();
    void metadata.warm(await library.list());
    void findMarks();
    res.json(await libraryResponse());
  });

  // Posters and stills come through the server, so friends' devices never talk to TMDB.
  app.get("/api/images/:size/:file", async (req, res) => {
    const file = await metadata.image(req.params.size, req.params.file).catch(() => null);
    if (!file) return void res.status(404).end();
    res.set("Cache-Control", "private, max-age=2592000, immutable");
    res.sendFile(file);
  });

  app.get("/api/metadata/search", async (req, res) => {
    const kind = req.query.kind === "tv" ? "tv" : "movie";
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    if (!q) return void res.json({ results: [] });
    try {
      res.json({ results: await metadata.search(kind, q) });
    } catch (err) {
      res.status(502).json({ error: `TMDB search failed: ${err instanceof Error ? err.message : err}` });
    }
  });

  // Fix match: the host picks the right TMDB movie or show (tmdbId), or none (null).
  app.post("/api/media/:id/match", async (req, res) => {
    const item = library.peek(req.params.id)?.item;
    if (!item) return void res.status(404).json({ error: "Not found." });
    const tmdbId = req.body?.tmdbId;
    if (tmdbId !== null && !(Number.isInteger(tmdbId) && tmdbId > 0)) return void res.status(400).json({ error: "tmdbId must be a TMDB id or null." });
    try {
      await metadata.setMatch(item, tmdbId);
      res.json(await libraryResponse());
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Skip times: what was found, and what the host set by hand over it (a kind left out is still found).
  const skipTimes = (item: MediaItem) => ({ found: markers.found(item) ?? {}, set: markers.handSet(item) });
  app.get("/api/media/:id/skip-times", (req, res) => {
    const item = library.peek(req.params.id)?.item;
    if (!item) return void res.status(404).json({ error: "Not found." });
    res.json(skipTimes(item));
  });
  app.put("/api/media/:id/skip-times", async (req, res) => {
    const item = library.peek(req.params.id)?.item;
    if (!item) return void res.status(404).json({ error: "Not found." });
    const set = handSet(req.body);
    if (!set) return void res.status(400).json({ error: "Times must be seconds, with each end after its start." });
    delete set.file;
    await markers.setHand(item, set);
    res.json(skipTimes(item));
  });
  app.delete("/api/media/:id/skip-times", async (req, res) => {
    const item = library.peek(req.params.id)?.item;
    if (!item) return void res.status(404).json({ error: "Not found." });
    await markers.setHand(item, null);
    res.json(skipTimes(item));
  });

  app.get("/api/media/:id/stream", async (req, res) => {
    const entry = await library.get(req.params.id);
    if (!entry) return void res.status(404).json({ error: "Not found." });

    let stat;
    try {
      stat = await fsp.stat(entry.absPath);
    } catch {
      return void res.status(404).json({ error: "File is gone." });
    }
    const size = stat.size;
    const range = parseRange(req.headers.range, size);

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", entry.item.mime);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Last-Modified", stat.mtime.toUTCString());

    if (range === "unsatisfiable") {
      res.setHeader("Content-Range", `bytes */${size}`);
      return void res.status(416).end();
    }

    const { start, end } = range ?? { start: 0, end: size - 1 };
    res.status(range ? 206 : 200);
    res.setHeader("Content-Length", String(end - start + 1));
    if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    if (req.method === "HEAD" || size === 0) return void res.end();

    const stream = fs.createReadStream(entry.absPath, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  });

  app.get("/api/media/:id/info", async (req, res) => {
    const entry = await library.get(req.params.id);
    if (!entry) return void res.status(404).json({ error: "Not found." });
    const probe = await transcoder.probe(entry.absPath);
    if (!probe) return void res.json({ info: null });
    const { videoIndex: _v, audioIndex: _a, subtitleIndexes: _s, ...info } = probe;
    res.json({ info });
  });

  // A converted copy for browsers that can't play the file (HEVC, AC3/DTS and the like), as HLS. Under light/, the
  // lighter copy for slow connections.
  const hlsPlaylist = (light: boolean) => async (req: express.Request, res: express.Response) => {
    const entry = await library.get(String(req.params.id));
    let text = entry && (await transcoder.playlist(entry.item.id, entry.absPath, light));
    if (!text) return void res.status(404).json({ error: "This file can't be converted." });
    // A playlist opened with ?token= passes it on to its segments, which players fetch by relative link.
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (token) text = text.replace(/^(\d+\.ts)$/gm, `$1?token=${encodeURIComponent(token)}`);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(text);
  };
  const hlsSegment = (light: boolean) => async (req: express.Request, res: express.Response) => {
    const match = /^(\d{1,6})\.ts$/.exec(String(req.params.segment));
    const entry = match && (await library.get(String(req.params.id)));
    if (!entry) return void res.status(404).json({ error: "Not found." });
    let file: string | null;
    try {
      file = await transcoder.segment(entry.item.id, entry.absPath, Number(match[1]), light);
    } catch (err) {
      return void res.status(500).json({ error: `Converting failed: ${(err as Error).message}` });
    }
    if (!file) return void res.status(404).json({ error: "Not found." });
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  };
  app.get("/api/media/:id/hls/index.m3u8", hlsPlaylist(false));
  app.get("/api/media/:id/hls/light/index.m3u8", hlsPlaylist(true));
  app.get("/api/media/:id/hls/light/:segment", hlsSegment(true));
  app.get("/api/media/:id/hls/:segment", hlsSegment(false));

  app.get("/api/media/:id/subtitles/:index", async (req, res) => {
    const entry = await library.get(req.params.id);
    // "e2.vtt" is the third subtitle track inside the file itself (see MediaInfo.subtitles).
    const embedded = /^e(\d{1,3})(\.vtt)?$/.exec(req.params.index);
    if (embedded) {
      const vtt = entry && (await transcoder.subtitle(entry.absPath, Number(embedded[1])));
      if (!vtt) return void res.status(404).json({ error: "Not found." });
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Cache-Control", "private, max-age=3600");
      return void res.send(vtt);
    }
    const file = entry?.subtitlePaths[Number(req.params.index.replace(/\.vtt$/, ""))];
    if (!file) return void res.status(404).json({ error: "Not found." });
    const text = await fsp.readFile(file, "utf8");
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.send(file.toLowerCase().endsWith(".srt") ? srtToVtt(text) : text);
  });

  // A party's summary plus where it is in its video, so the host's list can show progress.
  const withPlayback = async (room: Room): Promise<RoomSummary> => {
    const summary = room.summary();
    if (!summary.media) return summary;
    const entry = await library.get(summary.media.id);
    const probe = entry ? await transcoder.probe(entry.absPath) : null;
    return { ...summary, playback: { position: room.position(), paused: room.state.paused, duration: probe?.duration || null } };
  };

  app.get("/api/rooms", async (_req, res) => {
    res.json({ rooms: await Promise.all(rooms.parties().map(withPlayback)) });
  });

  // "Pick up where you left off": where parties stopped, newest first. Ones whose video left the library are skipped.
  app.get("/api/spots", async (_req, res) => {
    await library.list();
    const lookup = (id: string) => {
      const item = library.peek(id)?.item;
      return item && metadata.enrich(item);
    };
    const spots: Spot[] = [];
    for (const s of rooms.savedSpots()) {
      const media = lookup(s.mediaId);
      if (media) spots.push({ id: s.id, media, position: s.position, next: s.next.map(lookup).filter((m): m is MediaItem => !!m), savedAt: s.savedAt });
    }
    res.json({ spots });
  });

  // A still from the video where a spot stopped, for cards whose video has no TMDB art. Kept in memory per spot (they're
  // small, there are at most a handful, and a restart just grabs them again).
  const frames = new Map<string, Promise<Buffer | null>>();
  app.get("/api/spots/:id/frame.jpg", async (req, res) => {
    const spot = rooms.savedSpots().find((s) => s.id === req.params.id);
    const entry = spot && (await library.list(), library.peek(spot.mediaId));
    if (!spot || !entry) return void res.status(404).end();
    for (const id of frames.keys()) if (!rooms.spots.get(id)) frames.delete(id);
    let jpg = frames.get(spot.id);
    if (!jpg) frames.set(spot.id, (jpg = transcoder.frame(entry.absPath, spot.position)));
    const bytes = await jpg;
    if (!bytes) {
      frames.delete(spot.id);
      return void res.status(404).end();
    }
    res.set("Cache-Control", "private, max-age=86400").type("jpeg").send(bytes);
  });

  // History: every video played, newest first, with who was there. Ones whose video left the library are skipped.
  app.get("/api/history", async (_req, res) => {
    rooms.keepSpots();
    await library.list();
    const entries: HistoryEntry[] = [];
    for (const play of history.list()) {
      const item = library.peek(play.mediaId)?.item;
      if (item) entries.push({ ...play, media: withWatch(metadata.enrich(withDurations([item])[0])) });
    }
    res.json({ history: entries });
  });

  // Mark as watched / not watched: one video, or a whole season or show at once.
  app.post("/api/watched", async (req, res) => {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 5000 || ids.some((id) => typeof id !== "string") || typeof req.body?.watched !== "boolean") {
      return void res.status(400).json({ error: "Send ids (video ids) and watched (true or false)." });
    }
    await library.list();
    const known = (ids as string[]).filter((id) => library.peek(id));
    if (known.length === 0) return void res.status(404).json({ error: "Those videos aren't in the library." });
    history.mark(known, req.body.watched);
    res.json({ watch: Object.fromEntries(known.map((id) => [id, history.state(id) ?? null])) });
  });

  app.delete("/api/spots/:id", (req, res) => {
    if (!rooms.spots.remove(req.params.id)) return void res.status(404).json({ error: "No such spot." });
    res.status(204).end();
  });

  app.post("/api/rooms", async (req, res) => {
    // Watching alone: the host's own viewing, with no code to share until they invite friends.
    const solo = req.body?.solo === true;
    // Picking up a saved spot: its video, from where it stopped, with the rest lined up. The spot is used up.
    const spotId = req.body?.spot;
    if (spotId !== undefined) {
      const spot = typeof spotId === "string" ? rooms.savedSpots().find((s) => s.id === spotId) : undefined;
      if (!spot) return void res.status(404).json({ error: "That spot isn't saved anymore." });
      await library.list();
      const room = rooms.create(undefined, [spot.mediaId, ...spot.next], spot.position, solo);
      if (!room.media || room.media.id !== spot.mediaId) {
        room.end("the server");
        rooms.spots.remove(spot.id);
        return void res.status(400).json({ error: "That video isn't in the library anymore." });
      }
      rooms.spots.remove(spot.id);
      return void res.status(201).json({ room: room.summary() });
    }
    const mediaId = req.body?.mediaId;
    if (mediaId !== undefined && (typeof mediaId !== "string" || !(await library.get(mediaId)))) {
      return void res.status(400).json({ error: "That file is not in the library." });
    }
    // A binge: the videos to play one after another (unknown ones are skipped).
    const queue: unknown = req.body?.queue;
    if (queue !== undefined) {
      if (!Array.isArray(queue) || queue.length > MAX_QUEUE || queue.some((id) => typeof id !== "string")) {
        return void res.status(400).json({ error: "queue must be a list of video ids." });
      }
      await library.list();
      if (!queue.some((id) => library.peek(id))) return void res.status(400).json({ error: "Those files are not in the library." });
    }
    // From History: Pick up starts the video where it stopped.
    const at: unknown = req.body?.position;
    const position = typeof at === "number" && Number.isFinite(at) && at > 0 ? at : 0;
    res.status(201).json({ room: rooms.create(mediaId, queue as string[] | undefined, position, solo).summary() });
  });

  // Ends a party from the host's home screen, without joining it. Everyone in it is sent home.
  app.post("/api/rooms/:id/end", (req, res) => {
    const access: Access = res.locals.access;
    if (access.kind !== "host") return void res.status(403).json({ error: "Only the host can end a party." });
    const room = rooms.get(req.params.id);
    if (!room) return void res.status(404).json({ error: "No such room." });
    room.end(typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 32) : "the host", req.body?.save === true);
    res.status(204).end();
  });

  app.get("/api/rooms/:id", async (req, res) => {
    const room = rooms.get(req.params.id);
    if (!room) return void res.status(404).json({ error: "No such room." });
    res.json({ room: await withPlayback(room) });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  // The TV's QR code points here: a real path, so Android can hand it to the app (see assetlinks below).
  app.get("/pair/:id", (req, res) => {
    res.redirect(302, `/#/pair/${encodeURIComponent(req.params.id)}`);
  });

  // Invite links: a real path too, so phones with the app open it there, and browsers land on the join page.
  app.get("/join/:code", (req, res) => {
    res.redirect(302, `/#/join/${encodeURIComponent(req.params.code)}`);
  });

  // Lets Android open /pair and /join links in the app. Fingerprints come from Play Console (App signing).
  app.get("/.well-known/assetlinks.json", (_req, res) => {
    const android = config.androidApp;
    if (!android?.certFingerprints.length) return void res.status(404).end();
    res.json([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: android.packageName, sha256_cert_fingerprints: android.certFingerprints },
      },
    ]);
  });

  // Web client (single-page app with hash routing).
  if (fs.existsSync(path.join(config.webDir, "index.html"))) {
    app.use(express.static(config.webDir, { index: "index.html", maxAge: "1h" }));
  } else {
    app.get("/", (_req, res) => {
      res.type("text").send("Web client not built. Run `npm run build` at the repo root.");
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return void socket.destroy();
    const access = accessOf(req);
    if (!access || (access.kind === "guest" && rooms.get(url.searchParams.get("room") ?? "")?.id !== access.roomId)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return void socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, url, access.kind === "guest"));
  });

  async function onConnection(ws: WebSocket, url: URL, guest: boolean): Promise<void> {
    const send = (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const room = rooms.get(url.searchParams.get("room") ?? "");
    if (!room) {
      send({ type: "error", message: "No such room." });
      return void ws.close(4404, "No such room");
    }

    const device = url.searchParams.get("device");
    const member = room.join(
      url.searchParams.get("name") ?? "",
      send,
      device === "phone" || device === "tv" ? device : "web",
      () => ws.close(4404, "Party ended"),
      guest,
    );
    let alive = true;
    let unanswered = false;
    ws.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) {
        unanswered = true;
        return void ws.terminate();
      }
      alive = false;
      ws.ping();
    }, 30_000);

    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return send({ type: "error", message: "Bad JSON." });
      }
      if (msg && typeof msg === "object") room.handle(member.id, msg);
    });
    ws.on("close", (code) => {
      clearInterval(heartbeat);
      // 1000/1001/1005: the app or browser closed it (leaving, or the tab going); 4404: the party ended.
      const lost = unanswered ? "no answer to ping" : [1000, 1001, 1005, 4404].includes(code) ? null : `code ${code}`;
      room.leave(member.id, lost);
    });
  }

  const sweeper = setInterval(() => {
    rooms.sweep();
    for (const id of pairings.keys()) pending(id);
  }, 60_000);
  sweeper.unref();
  const keeper = setInterval(() => rooms.keepSpots(), 15_000);
  keeper.unref();

  return {
    server,
    library,
    rooms,
    transcoder,
    metadata,
    markers,
    findMarks,
    async close() {
      clearInterval(sweeper);
      clearInterval(keeper);
      rooms.keepSpots();
      await markers.close();
      await transcoder.close();
      await metadata.close();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
