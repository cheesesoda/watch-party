import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import type { ServerMessage } from "../../shared/protocol.ts";
import { createApp, type App } from "../src/app.ts";

let app: App;
let base: string;
let token: string;
let dir: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-"));
  await fs.mkdir(path.join(dir, "Shows"));
  await fs.writeFile(path.join(dir, "Shows", "Ep.One.mp4"), Buffer.from("0123456789"));
  await fs.writeFile(path.join(dir, "Shows", "Ep.One.en.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHello\n");
  await fs.writeFile(path.join(dir, "notes.txt"), "ignore me");
  app = createApp({ port: 0, host: "127.0.0.1", mediaDirs: [dir], password: "secret", allowNoPassword: false, webDir: dir, iceServers: [], trustProxy: "loopback" });
  await app.library.scan();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => {
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const auth = () => ({ Authorization: `Bearer ${token}` });

test("login is required and checks the password", async () => {
  assert.equal((await fetch(`${base}/api/library`)).status, 401);
  const bad = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"password":"nope"}' });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"password":"secret"}' });
  assert.equal(ok.status, 200);
  token = (await ok.json()).token;
  assert.match(ok.headers.get("set-cookie") ?? "", /wp_token=/);
  assert.doesNotMatch(ok.headers.get("set-cookie") ?? "", /Secure/);
  const https = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-proto": "https" }, body: '{"password":"secret"}' });
  assert.match(https.headers.get("set-cookie") ?? "", /; Secure/);
});

test("library lists videos with sidecar subtitles", async () => {
  const { items, convert } = await (await fetch(`${base}/api/library`, { headers: auth() })).json();
  // Converting is off in tests, so browsers get the warning for formats they can't play.
  assert.equal(convert, false);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Ep One");
  assert.equal(items[0].folder, "Shows");
  assert.deepEqual(items[0].subtitles, [{ index: 0, label: "en", lang: "en" }]);

  const vtt = await fetch(`${base}/api/media/${items[0].id}/subtitles/0.vtt?token=${token}`);
  assert.equal(await vtt.text(), "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello\n");
});

test("streams with range support", async () => {
  const { items } = await (await fetch(`${base}/api/library`, { headers: auth() })).json();
  const url = `${base}/api/media/${items[0].id}/stream?token=${token}`;
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), "0123456789");
  const part = await fetch(url, { headers: { Range: "bytes=2-4" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await part.text(), "234");
  assert.equal((await fetch(url, { headers: { Range: "bytes=50-" } })).status, 416);
});

function connect(roomId: string, name: string, as: string | null = token) {
  const qs = new URLSearchParams({ room: roomId, name, ...(as ? { token: as } : {}) });
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws?${qs}`);
  const inbox: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (d) => {
    inbox.push(JSON.parse(String(d)));
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (pred: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
    for (;;) {
      const idx = inbox.findIndex(pred);
      if (idx >= 0) return inbox.splice(idx, 1)[0];
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  return { ws, next };
}

test("websocket rooms sync playback and chat", async () => {
  const { items } = await (await fetch(`${base}/api/library`, { headers: auth() })).json();
  const res = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ mediaId: items[0].id }),
  });
  assert.equal(res.status, 201);
  const { room } = await res.json();

  const denied = new WebSocket(`${base.replace("http", "ws")}/ws?room=${room.id}`);
  await new Promise<void>((r) => denied.on("error", () => r()));

  const a = connect(room.id, "Ann");
  const b = connect(room.id, "Ben");
  const welcome = await b.next((m) => m.type === "welcome");
  assert.ok(welcome.type === "welcome" && welcome.media?.title === "Ep One");

  a.ws.send(JSON.stringify({ type: "play", position: 3 }));
  const st = await b.next((m) => m.type === "state");
  assert.ok(st.type === "state" && !st.state.paused && st.state.position === 3 && st.by === "Ann");

  b.ws.send(JSON.stringify({ type: "chat", text: "popcorn?" }));
  const chat = await a.next((m) => m.type === "chat" && !m.message.system);
  assert.ok(chat.type === "chat" && chat.message.from === "Ben" && chat.message.text === "popcorn?");

  const listed = await (await fetch(`${base}/api/rooms`, { headers: auth() })).json();
  assert.equal(listed.rooms[0].members.length, 2);

  a.ws.close();
  b.ws.close();
});

test("a party code lets a viewer into that party only, until it ends", async () => {
  const { items } = await (await fetch(`${base}/api/library`, { headers: auth() })).json();
  const create = (mediaId?: string) =>
    fetch(`${base}/api/rooms`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ mediaId }) }).then((r) => r.json());
  const { room } = await create();
  const { room: other } = await create(items[0].id);
  const join = (code: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/join`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "100.64.1.1", ...headers }, body: JSON.stringify({ code }) });

  assert.equal((await join("nope00")).status, 404);
  const hostJoin = await (await join(room.id.toUpperCase(), auth())).json();
  assert.equal(hostJoin.token, null, "the host keeps their own sign-in");
  const res = await join(` ${room.id.toUpperCase()} `);
  assert.equal(res.status, 200);
  const guest: string = (await res.json()).token;
  assert.match(res.headers.get("set-cookie") ?? "", /wp_token=g\./);
  const as = { Authorization: `Bearer ${guest}` };

  assert.deepEqual(await (await fetch(`${base}/api/me`, { headers: as })).json(), { ok: true, role: "guest", room: room.id });
  assert.equal((await fetch(`${base}/api/rooms/${room.id}`, { headers: as })).status, 200);
  for (const path of ["/api/library", "/api/rooms", `/api/rooms/${other.id}`, `/api/media/${items[0].id}/stream`]) {
    assert.equal((await fetch(base + path, { headers: as })).status, 403, path);
  }
  assert.equal((await fetch(`${base}/api/rooms`, { method: "POST", headers: { ...as, "content-type": "application/json" }, body: "{}" })).status, 403);

  const denied = new WebSocket(`${base.replace("http", "ws")}/ws?room=${other.id}&token=${guest}`);
  await new Promise<void>((r) => denied.on("error", () => r()));

  const host = connect(room.id, "Host");
  const viewer = connect(room.id, "Viewer", guest);
  await viewer.next((m) => m.type === "welcome");
  viewer.ws.send(JSON.stringify({ type: "select", mediaId: items[0].id }));
  assert.ok((await viewer.next((m) => m.type === "error")).type === "error");
  viewer.ws.send(JSON.stringify({ type: "end" }));
  assert.ok((await viewer.next((m) => m.type === "error")).type === "error");

  // Once the host picks something, the viewer can stream it.
  host.ws.send(JSON.stringify({ type: "select", mediaId: items[0].id }));
  await viewer.next((m) => m.type === "state");
  assert.equal((await fetch(`${base}/api/media/${items[0].id}/stream`, { headers: as })).status, 200);

  host.ws.send(JSON.stringify({ type: "end" }));
  await viewer.next((m) => m.type === "ended");
  assert.equal((await fetch(`${base}/api/me`, { headers: as })).status, 401);
  assert.equal((await join(room.id)).status, 404);
  host.ws.close();
  viewer.ws.close();
});

test("the host ends a party from the home screen; viewers can't", async () => {
  const post = (path: string, headers: Record<string, string>, body: object = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const { room } = await (await post("/api/rooms", auth())).json();
  const guest: string = (await (await post("/api/join", { "x-forwarded-for": "100.64.1.2" }, { code: room.id })).json()).token;
  const viewer = connect(room.id, "Viewer", guest);
  await viewer.next((m) => m.type === "welcome");

  assert.equal((await post(`/api/rooms/${room.id}/end`, { Authorization: `Bearer ${guest}` })).status, 403);
  assert.equal((await post(`/api/rooms/${room.id}/end`, auth(), { name: "Jake" })).status, 204);
  const ended = await viewer.next((m) => m.type === "ended");
  assert.equal(ended.type === "ended" && ended.by, "Jake");
  assert.equal((await fetch(`${base}/api/rooms/${room.id}`, { headers: auth() })).status, 404);
  assert.equal((await post(`/api/rooms/${room.id}/end`, auth())).status, 404);
  viewer.ws.close();
});

test("a TV signs in by QR: the phone enters a party code or the password", async () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "100.64.2.1", ...headers }, body: JSON.stringify(body) });
  const { room } = await (await post("/api/rooms", {}, auth())).json();

  const { id } = await (await post("/api/pair", {})).json();
  assert.deepEqual(await (await fetch(`${base}/api/pair/${id}`)).json(), { status: "waiting" });
  assert.equal((await post(`/api/pair/${id}`, { name: "Sam", code: "nope00" })).status, 404);
  assert.equal((await post(`/api/pair/${id}`, { name: "Sam", code: room.id.toUpperCase() })).status, 200);
  const done = await (await fetch(`${base}/api/pair/${id}`)).json();
  assert.equal(done.status, "done");
  assert.equal(done.role, "guest");
  assert.equal(done.room, room.id);
  assert.equal(done.name, "Sam");
  assert.equal((await fetch(`${base}/api/rooms/${room.id}`, { headers: { Authorization: `Bearer ${done.token}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/pair/${id}`)).status, 404, "a pass is handed out once");

  const host = (await (await post("/api/pair", {})).json()).id;
  assert.equal((await post(`/api/pair/${host}`, { name: "Jake", password: "wrong" })).status, 401);
  assert.equal((await post(`/api/pair/${host}`, { name: "Jake" }, auth())).status, 200);
  const hostDone = await (await fetch(`${base}/api/pair/${host}`)).json();
  assert.equal(hostDone.role, "host");
  assert.equal(hostDone.token, token);

  const page = await fetch(`${base}/pair/${host}`, { redirect: "manual" });
  assert.equal(page.headers.get("location"), `/#/pair/${host}`);
  const invite = await fetch(`${base}/join/ABC123`, { redirect: "manual" });
  assert.equal(invite.headers.get("location"), "/#/join/ABC123");
  assert.equal((await fetch(`${base}/.well-known/assetlinks.json`)).status, 404);
});

test("behind a local proxy, one visitor's wrong passwords don't lock out another", async () => {
  // The test client connects from 127.0.0.1, like `tailscale serve` does, and names the visitor.
  const attempt = (password: string, visitor: string) =>
    fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": visitor },
      body: JSON.stringify({ password }),
    });
  for (let i = 0; i < 10; i++) assert.equal((await attempt("guess" + i, "100.64.0.1")).status, 401);
  assert.equal((await attempt("secret", "100.64.0.1")).status, 429);
  assert.equal((await attempt("secret", "100.64.0.2")).status, 200);
});

test("login is rate limited after repeated wrong passwords", async () => {
  const attempt = (password: string) =>
    fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  for (let i = 0; i < 10; i++) assert.equal((await attempt("guess" + i)).status, 401);
  const blocked = await attempt("secret");
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
});

test("the party list shows where each party is in its video", async () => {
  const { items } = await (await fetch(`${base}/api/library`, { headers: auth() })).json();
  const res = await fetch(`${base}/api/rooms`, { method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify({ mediaId: items[0].id }) });
  const { room } = await res.json();
  const host = connect(room.id, "Jake");
  await host.next((m) => m.type === "welcome");
  host.ws.send(JSON.stringify({ type: "pause", position: 95 }));
  await host.next((m) => m.type === "state");

  const { rooms } = await (await fetch(`${base}/api/rooms`, { headers: auth() })).json();
  const listed = rooms.find((r: { id: string }) => r.id === room.id);
  // The test file isn't a real video, so ffprobe can't tell its length.
  assert.deepEqual(listed.playback, { position: 95, paused: true, duration: null });
  const one = await (await fetch(`${base}/api/rooms/${room.id}`, { headers: auth() })).json();
  assert.equal(one.room.playback.position, 95);
  host.ws.close();
});
