import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { APK_URL, config, createProxy, inviteRoute } from "../server.mjs";

// A stand-in for the Popcorn Club server: echoes what it was sent, and upgrades /ws to a WebSocket.
let upstream, proxy, base, seen;
const sockets = new Set();
before(async () => {
  upstream = http.createServer((req, res) => {
    seen = req.headers;
    if (req.url === "/.well-known/assetlinks.json") return void res.end("[]");
    res.setHeader("set-cookie", "wp_token=abc; HttpOnly");
    res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
  });
  upstream.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(d));
  });
  await new Promise((r) => upstream.listen(0, r));
  const cfg = config({ UPSTREAM: `http://127.0.0.1:${upstream.address().port}`, PROXY_KEY: "k" });
  proxy = createProxy(cfg);
  await new Promise((r) => proxy.listen(0, r));
  base = `http://127.0.0.1:${proxy.address().port}`;
});
after(() => {
  for (const s of sockets) s.destroy();
  proxy.closeAllConnections();
  proxy.close();
  upstream.closeAllConnections();
  upstream.close();
});

// node:http rather than fetch, which won't send a made-up Host header.
function request(url, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url + path, { headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: body, json: () => JSON.parse(body) }));
    });
    req.on("error", reject);
  });
}
const get = (path, host, headers = {}) => request(base, path, { host, ...headers });

test("invite links forward to the app", async () => {
  const res = await get("/join/ABC123", "tv.chzsda.com");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "https://app.tv.chzsda.com/join/ABC123");
  assert.equal(inviteRoute("/", "app.x"), "https://app.x/");
  // A scheduled party's title and time go along, nothing else.
  assert.equal(inviteRoute("/join/ABC123?t=Charade%20%26%20co&at=123&x=1", "app.x"), "https://app.x/join/ABC123?t=Charade+%26+co&at=123");
});

test("tv.chzsda.com/apk downloads the Fire TV app", async () => {
  const res = await get("/apk", "tv.chzsda.com");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, APK_URL);
});

test("assetlinks on the invite host comes from the server", async () => {
  const res = await get("/.well-known/assetlinks.json", "tv.chzsda.com");
  assert.equal(res.text, "[]");
});

test("the app host passes requests through, with the visitor and the server's own host name", async () => {
  const res = await get("/api/me?x=1", "app.tv.chzsda.com", { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-popcorn-client": "spoofed" });
  const body = res.json();
  assert.equal(body.path, "/api/me?x=1");
  assert.match(body.host, /^127\.0\.0\.1:/);
  assert.equal(res.headers["set-cookie"]?.[0], "wp_token=abc; HttpOnly");
  assert.equal(seen["x-popcorn-client"], "203.0.113.9");
  assert.equal(seen["x-popcorn-proxy-key"], "k");
});

test("the party connection upgrades and carries messages both ways", async () => {
  const net = await import("node:net");
  const socket = net.connect(proxy.address().port, "127.0.0.1");
  socket.write("GET /ws HTTP/1.1\r\nHost: app.tv.chzsda.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  let got = "";
  await new Promise((resolve) => {
    socket.on("data", (d) => {
      got += d;
      if (got.includes("\r\n\r\n") && !got.includes("ping")) socket.write("ping");
      if (got.includes("ping")) resolve();
    });
  });
  assert.match(got, /^HTTP\/1\.1 101/);
  socket.destroy();
});

test("pages say the server is off when the PC doesn't answer", async () => {
  const dead = createProxy(config({ UPSTREAM: "http://127.0.0.1:9" }));
  await new Promise((r) => dead.listen(0, r));
  const url = `http://127.0.0.1:${dead.address().port}`;
  const page = await request(url, "/", { host: "app.tv.chzsda.com", accept: "text/html" });
  assert.equal(page.status, 503);
  assert.match(page.text, /party server is off/);
  const api = await request(url, "/api/rooms", { host: "app.tv.chzsda.com" });
  assert.equal(api.status, 503);
  assert.equal(api.json().error, "The party server is off right now.");
  dead.closeAllConnections();
  dead.close();
});
