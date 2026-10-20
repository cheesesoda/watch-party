// A small proxy for the host's own domain, run on Railway:
// - APP_HOST (app.tv.chzsda.com): the dashboard, sign-in, API and party connection, passed to UPSTREAM
//   (the host's PC on its ts.net address). Video and posters don't come through here: the pages load them
//   straight from the PC (the server's MEDIA_URL).
// - INVITE_HOST (tv.chzsda.com): invite links. /join/CODE forwards to the app, and assetlinks.json comes
//   from the server so phones open those links in the Android app.
// When the PC doesn't answer, pages get a short "the party server is off" page instead of an error.
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";

/** Headers that describe one connection, not the request, so they aren't passed on. */
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host"]);

export function config(env = process.env) {
  const upstream = new URL(env.UPSTREAM ?? "https://omnipotent.tail3b2bb0.ts.net");
  return {
    port: Number(env.PORT ?? 8080),
    upstream,
    appHost: (env.APP_HOST ?? "app.tv.chzsda.com").toLowerCase(),
    inviteHost: (env.INVITE_HOST ?? "tv.chzsda.com").toLowerCase(),
    proxyKey: env.PROXY_KEY ?? "",
  };
}

/** The visitor's address: the first X-Forwarded-For entry, which Railway's edge sets. */
export function visitorOf(req) {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/** What INVITE_HOST answers for a path: a redirect to the app, or null to pass it to the server. */
/** The Fire TV app, at an address short enough to type on a remote (Downloader app). */
export const APK_URL = "https://github.com/cheesesoda/watch-party/releases/latest/download/popcorn-club.apk";

export function inviteRoute(path, appHost) {
  if (path.startsWith("/.well-known/")) return null;
  if (/^\/apk\/?$/i.test(path.split("?")[0])) return APK_URL;
  const join = /^\/join\/([\w-]{1,32})\/?$/.exec(path.split("?")[0]);
  if (join) {
    // A scheduled party's link carries its title and start time (t, at), for the page below while the PC is off.
    const given = new URLSearchParams(path.split("?")[1] ?? "");
    const keep = new URLSearchParams([...given].filter(([k]) => k === "t" || k === "at"));
    return `https://${appHost}/join/${join[1]}${keep.size ? `?${keep}` : ""}`;
  }
  return `https://${appHost}/`;
}

function upstreamHeaders(req, cfg) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith("x-popcorn-")) headers[k] = v;
  headers.host = cfg.upstream.host;
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-forwarded-proto"] = "https";
  if (cfg.proxyKey) {
    headers["x-popcorn-proxy-key"] = cfg.proxyKey;
    headers["x-popcorn-client"] = visitorOf(req);
  }
  return headers;
}

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Popcorn Club</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#8a3a5a,#2b2140);color:#eeeaf3;font:16px/1.5 system-ui,sans-serif;text-align:center}
main{padding:32px;max-width:420px}h1{font-size:26px;margin:0 0 8px}p{color:#d6cfe0;margin:0 0 20px}
button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:10px 22px;background:#e09a62;color:#18131f;cursor:pointer;display:inline-flex;gap:8px;align-items:center}
.when{background:rgba(24,19,31,.55);border-radius:16px;padding:14px 16px;margin:0 0 20px}.when b{display:block;font-size:18px;color:#fff}.when span{font-size:14px;color:#d6cfe0}
</style></head><body><main><h1>The party server is off</h1>
<p>The host's computer isn't answering right now. Try again once they say it's on.</p>
<button onclick="location.reload()">Try again</button></main>
<script>${scheduledPage.toString()};scheduledPage()</script></body></html>`;

/**
 * Runs in the offline page: a scheduled party's invite (/join/CODE?t=Title&at=ms) shows its title and start time,
 * with Add to calendar, since the PC is usually off until party night. Built with textContent, never as HTML.
 */
function scheduledPage() {
  const code = /^\/join\/([\w-]{1,32})\/?$/.exec(location.pathname)?.[1];
  const q = new URLSearchParams(location.search);
  const title = (q.get("t") ?? "").slice(0, 120);
  const at = Number(q.get("at"));
  if (!code || !title || !Number.isFinite(at) || at < Date.now() - 6 * 3600e3) return;
  const link = location.origin + "/join/" + code.toUpperCase();
  const d = new Date(at);
  const when = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " at " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  const box = el("div", "when", "");
  box.append(el("b", "", "Starts " + when), el("span", "", "Open this link again then."));
  const add = el("button", "", "");
  add.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4M16 2v4"/><path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8"/><path d="M3 10h18M16 19h6M19 16v6"/></svg>';
  add.append("Add to calendar");
  add.onclick = () => {
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
    const t = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Popcorn Club//EN", "BEGIN:VEVENT", "UID:" + code.toLowerCase() + "-" + at + "@popcorn-club",
      "DTSTAMP:" + t(Date.now()), "DTSTART:" + t(at), "DTEND:" + t(at + 2 * 3600e3), "SUMMARY:" + esc(title + " watch party"),
      "DESCRIPTION:" + esc("Join: " + link + "\nParty code: " + code.toUpperCase()), "URL:" + link,
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(title + " watch party starts in 30 minutes"), "TRIGGER:-PT30M", "END:VALARM",
      "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    const a = Object.assign(document.createElement("a"), { href: "data:text/calendar;charset=utf-8," + encodeURIComponent(ics), download: "watch-party.ics" });
    document.body.append(a);
    a.click();
    a.remove();
  };
  const main = document.querySelector("main");
  main.replaceChildren(el("h1", "", title), box, add);
}

function offline(req, res) {
  if (res.headersSent) return void res.destroy();
  const wantsPage = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
  res.writeHead(503, { "content-type": wantsPage ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store", "retry-after": "30" });
  res.end(wantsPage ? OFFLINE : JSON.stringify({ error: "The party server is off right now." }));
}

export function createProxy(cfg = config()) {
  // https for the real ts.net address; plain http lets tests point it at a local server.
  const secure = cfg.upstream.protocol === "https:";
  const client = secure ? https : http;
  const agent = new client.Agent({ keepAlive: true });
  const port = Number(cfg.upstream.port) || (secure ? 443 : 80);

  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
    if (req.url === "/healthz") return void res.end("ok");
    if (host === cfg.inviteHost) {
      const to = inviteRoute(req.url ?? "/", cfg.appHost);
      if (to) {
        res.writeHead(302, { location: to, "cache-control": "no-store" });
        return void res.end();
      }
    }
    const up = client.request(
      { host: cfg.upstream.hostname, port, method: req.method, path: req.url, headers: upstreamHeaders(req, cfg), agent, servername: cfg.upstream.hostname, timeout: 60_000 },
      (upRes) => {
        // Tailscale answers 502/504 itself when the PC is off or asleep.
        if (upRes.statusCode === 502 || upRes.statusCode === 504) {
          upRes.resume();
          return offline(req, res);
        }
        const headers = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k)) headers[k] = v;
        res.writeHead(upRes.statusCode ?? 502, headers);
        upRes.pipe(res);
      },
    );
    up.on("timeout", () => up.destroy(new Error("timeout")));
    up.on("error", () => offline(req, res));
    req.pipe(up);
  });

  // The party connection (chat, sync, voice signaling) is a WebSocket: pass the upgrade through as raw bytes.
  server.on("upgrade", (req, socket, head) => {
    const up = client.request({
      host: cfg.upstream.hostname,
      port,
      method: "GET",
      path: req.url,
      headers: { ...upstreamHeaders(req, cfg), connection: "Upgrade", upgrade: req.headers.upgrade ?? "websocket" },
      servername: cfg.upstream.hostname,
    });
    up.on("upgrade", (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      const close = () => {
        upSocket.destroy();
        socket.destroy();
      };
      upSocket.on("error", close);
      socket.on("error", close);
      upSocket.on("close", close);
      socket.on("close", close);
    });
    up.on("response", (upRes) => {
      // Refused (bad pass, ended party): hand the answer back as is.
      socket.end(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\nconnection: close\r\n\r\n`);
      upRes.resume();
    });
    up.on("error", () => socket.end("HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n"));
    up.end();
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = config();
  createProxy(cfg).listen(cfg.port, () => console.log(`proxy on :${cfg.port} → ${cfg.upstream.origin} (${cfg.appHost}, ${cfg.inviteHost})`));
}
