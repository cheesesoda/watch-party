import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";
import { checkPassword, COOKIE_NAME, isAuthorized, tokenFor } from "./auth.ts";
import type { Config } from "./config.ts";
import { Library } from "./library.ts";
import { parseRange } from "./range.ts";
import { FailureLimiter } from "./ratelimit.ts";
import { RoomManager } from "./rooms.ts";
import { srtToVtt } from "./subtitles.ts";

export interface App {
  server: http.Server;
  library: Library;
  rooms: RoomManager;
  close(): Promise<void>;
}

export function createApp(config: Config): App {
  const library = new Library(config.mediaDirs);
  const rooms = new RoomManager((id) => library.peek(id)?.item);
  const app = express();
  app.disable("x-powered-by");
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
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", maxAge: 365 * 24 * 3600 * 1000 });
    res.json({ token });
  });

  app.post("/api/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
  });

  app.use("/api", (req, res, next) => {
    if (isAuthorized(config.password, req)) return next();
    res.status(401).json({ error: "Not signed in." });
  });

  app.get("/api/me", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/library", async (_req, res) => {
    res.json({ items: await library.list() });
  });

  app.post("/api/library/rescan", async (_req, res) => {
    await library.scan();
    res.json({ items: await library.list() });
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

  app.get("/api/media/:id/subtitles/:index", async (req, res) => {
    const entry = await library.get(req.params.id);
    const file = entry?.subtitlePaths[Number(req.params.index.replace(/\.vtt$/, ""))];
    if (!file) return void res.status(404).json({ error: "Not found." });
    const text = await fsp.readFile(file, "utf8");
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.send(file.toLowerCase().endsWith(".srt") ? srtToVtt(text) : text);
  });

  app.get("/api/rooms", (_req, res) => {
    res.json({ rooms: rooms.list() });
  });

  app.post("/api/rooms", async (req, res) => {
    const mediaId = req.body?.mediaId;
    if (mediaId !== undefined && (typeof mediaId !== "string" || !(await library.get(mediaId)))) {
      return void res.status(400).json({ error: "That file is not in the library." });
    }
    res.status(201).json({ room: rooms.create(mediaId).summary() });
  });

  app.get("/api/rooms/:id", (req, res) => {
    const room = rooms.get(req.params.id);
    if (!room) return void res.status(404).json({ error: "No such room." });
    res.json({ room: room.summary() });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
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
    if (!isAuthorized(config.password, req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return void socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, url));
  });

  async function onConnection(ws: WebSocket, url: URL): Promise<void> {
    const send = (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const room = rooms.get(url.searchParams.get("room") ?? "");
    if (!room) {
      send({ type: "error", message: "No such room." });
      return void ws.close(4404, "No such room");
    }

    const member = room.join(url.searchParams.get("name") ?? "", send);
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

  const sweeper = setInterval(() => rooms.sweep(), 60_000);
  sweeper.unref();

  return {
    server,
    library,
    rooms,
    async close() {
      clearInterval(sweeper);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
