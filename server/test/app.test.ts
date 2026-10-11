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
  app = createApp({ port: 0, host: "127.0.0.1", mediaDirs: [dir], password: "secret", allowNoPassword: false, webDir: dir });
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
});

test("library lists videos with sidecar subtitles", async () => {
  const { items } = await (await fetch(`${base}/api/library`, { headers: auth() })).json();
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

function connect(roomId: string, name: string, withToken = true) {
  const qs = new URLSearchParams({ room: roomId, name, ...(withToken ? { token } : {}) });
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

test("login is rate limited after repeated wrong passwords", async () => {
  const attempt = (password: string) =>
    fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  for (let i = 0; i < 10; i++) assert.equal((await attempt("guess" + i)).status, 401);
  const blocked = await attempt("secret");
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
});
