import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, MediaItem, RoomSummary, ServerMessage } from "../../shared/protocol.ts";
import type { IncomingMessage } from "node:http";
import { checkPassword, COOKIE_NAME, extractToken, guestToken, parseGuestToken, safeEqual, tokenFor, type Access } from "./auth.ts";
import type { Config } from "./config.ts";
import { Library } from "./library.ts";
import { parseRange } from "./range.ts";
import { FailureLimiter } from "./ratelimit.ts";
import { cleanName, RoomManager, type Room } from "./rooms.ts";
import { srtToVtt } from "./subtitles.ts";
import { Transcoder } from "./transcode.ts";

export interface App {
  server: http.Server;
  library: Library;
  rooms: RoomManager;
  transcoder: Transcoder;
  close(): Promise<void>;
}

export function createApp(config: Config): App {
  const library = new Library(config.mediaDirs);
  const rooms = new RoomManager((id) => library.peek(id)?.item, Date.now, undefined, config.iceServers);
  const transcoder = new Transcoder(config.transcode ?? { ffmpeg: "ffmpeg", ffprobe: "ffprobe", dir: "", encoder: "off" });
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(express.json({ limit: "16kb" }));

  // Lets the Android app and other origins talk to the API.
  app.use("/api", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, authRequired: Boolean(config.password) });
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
    const client = req.ip ?? "unknown";
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
    const client = req.ip ?? "unknown";
    const wait = joinLimiter.blockedFor(client);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      return void res.status(429).json({ error: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.` });
    }
    const code = req.body?.code;
    const room = typeof code === "string" && code.trim() ? rooms.get(code.trim()) : undefined;
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
    const client = req.ip ?? "unknown";
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
    const client = req.ip ?? "unknown";
    const name = cleanName(req.body?.name);
    const code = req.body?.code;

    if (typeof code === "string" && code.trim()) {
      const wait = joinLimiter.blockedFor(client);
      if (wait > 0) return void res.status(429).json({ error: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.` });
      const room = rooms.get(code.trim());
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

  app.get("/api/me", (_req, res) => {
    const access: Access = res.locals.access;
    res.json(access.kind === "host" ? { ok: true, role: "host" } : { ok: true, role: "guest", room: access.roomId });
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
  // Everything else (the library, the list of parties, starting one) is for the host.
  app.use("/api", (req, res, next) => {
    const access: Access = res.locals.access;
    if (access.kind === "host" || /^\/(media|rooms)\/[^/]+/.test(req.path)) return next();
    res.status(403).json({ error: "Only the host can do that. Ask them for the password." });
  });

  // convert: the server can turn any file into something browsers play (ffmpeg is installed).
  const libraryResponse = async () => ({ items: withDurations(await library.list()), convert: (await transcoder.encoderName()) !== null });

  // Lengths come from ffprobe, which takes a moment per file, so they're read one file at a time in the
  // background and show up on later loads of the library.
  const queued = new Set<string>();
  let probing: Promise<unknown> = Promise.resolve();
  const withDurations = (items: MediaItem[]): MediaItem[] =>
    items.map((item) => {
      const entry = library.peek(item.id);
      if (!entry) return item;
      const duration = transcoder.cachedDuration(entry.absPath);
      if (duration === undefined && !queued.has(entry.absPath)) {
        queued.add(entry.absPath);
        probing = probing.then(() => transcoder.probe(entry.absPath)).catch(() => null);
      }
      return duration ? { ...item, duration } : item;
    });

  app.get("/api/library", async (_req, res) => {
    res.json(await libraryResponse());
  });

  app.post("/api/library/rescan", async (_req, res) => {
    await library.scan();
    res.json(await libraryResponse());
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
    const { videoIndex: _v, audioIndex: _a, ...info } = probe;
    res.json({ info });
  });

  // A converted copy for browsers that can't play the file (HEVC, AC3/DTS and the like), as HLS.
  app.get("/api/media/:id/hls/index.m3u8", async (req, res) => {
    const entry = await library.get(req.params.id);
    const text = entry && (await transcoder.playlist(entry.item.id, entry.absPath));
    if (!text) return void res.status(404).json({ error: "This file can't be converted." });
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(text);
  });

  app.get("/api/media/:id/hls/:segment", async (req, res) => {
    const match = /^(\d{1,6})\.ts$/.exec(req.params.segment);
    const entry = match && (await library.get(req.params.id));
    if (!entry) return void res.status(404).json({ error: "Not found." });
    let file: string | null;
    try {
      file = await transcoder.segment(entry.item.id, entry.absPath, Number(match[1]));
    } catch (err) {
      return void res.status(500).json({ error: `Converting failed: ${(err as Error).message}` });
    }
    if (!file) return void res.status(404).json({ error: "Not found." });
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.get("/api/media/:id/subtitles/:index", async (req, res) => {
    const entry = await library.get(req.params.id);
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
    res.json({ rooms: await Promise.all([...rooms.rooms.values()].map(withPlayback)) });
  });

  app.post("/api/rooms", async (req, res) => {
    const mediaId = req.body?.mediaId;
    if (mediaId !== undefined && (typeof mediaId !== "string" || !(await library.get(mediaId)))) {
      return void res.status(400).json({ error: "That file is not in the library." });
    }
    res.status(201).json({ room: rooms.create(mediaId).summary() });
  });

  // Ends a party from the host's home screen, without joining it. Everyone in it is sent home.
  app.post("/api/rooms/:id/end", (req, res) => {
    const access: Access = res.locals.access;
    if (access.kind !== "host") return void res.status(403).json({ error: "Only the host can end a party." });
    const room = rooms.get(req.params.id);
    if (!room) return void res.status(404).json({ error: "No such room." });
    room.end(typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 32) : "the host");
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
    ws.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return void ws.terminate();
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
    ws.on("close", () => {
      clearInterval(heartbeat);
      room.leave(member.id);
    });
  }

  const sweeper = setInterval(() => {
    rooms.sweep();
    for (const id of pairings.keys()) pending(id);
  }, 60_000);
  sweeper.unref();

  return {
    server,
    library,
    rooms,
    transcoder,
    async close() {
      clearInterval(sweeper);
      await transcoder.close();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
