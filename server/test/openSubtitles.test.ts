import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { MediaItem } from "../../shared/protocol.ts";
import { Library } from "../src/library.ts";
import { downloadedFile, movieHash, OpenSubtitles } from "../src/openSubtitles.ts";

const SRT = "1\n00:00:01,000 --> 00:00:03,000\nOf all the gin joints in all the towns.\n";

test("the movie hash is the file's size plus its first and last 64 KB as 64-bit numbers", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-os-"));
  try {
    const file = path.join(dir, "v.mkv");
    const buf = Buffer.alloc(200_000);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) % 251;
    await fs.writeFile(file, buf);
    // The same sum done the slow way.
    let sum = BigInt(buf.length);
    for (const at of [0, buf.length - 65536]) for (let i = 0; i < 65536; i += 8) sum += buf.readBigUInt64LE(at + i);
    assert.equal(await movieHash(file), (sum & ((1n << 64n) - 1n)).toString(16).padStart(16, "0"));
    await fs.writeFile(file, "tiny");
    assert.equal(await movieHash(file), null, "too small to hash");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Find subtitles lists English ones made for the file first, skips machine translations, and saves a download", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-os-"));
  try {
    const media = path.join(dir, "media");
    await fs.mkdir(media);
    await fs.writeFile(path.join(media, "Casablanca (1942).mp4"), Buffer.alloc(70_000, 1));
    const subs = path.join(dir, "subtitles");
    const calls: { url: string; init?: RequestInit }[] = [];
    const row = (fileId: number, release: string, downloads: number, extra: Record<string, unknown> = {}) => ({
      attributes: { release, download_count: downloads, files: [{ file_id: fileId }], moviehash_match: false, hearing_impaired: false, ...extra },
    });
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.endsWith("/login")) return Response.json({ token: "tok", user: { remaining_downloads: 20 } });
      if (u.includes("/subtitles?"))
        return Response.json({
          data: [row(1, "Casablanca.DVDRip", 300), row(2, "Casablanca.1942.1080p.BluRay", 50, { moviehash_match: true }), row(3, "Casablanca.AI", 9000, { ai_translated: true }), row(4, "Casablanca.BDRip", 900, { hearing_impaired: true })],
        });
      if (u.endsWith("/download")) return Response.json({ link: "https://dl.example/file.srt", remaining: 19 });
      if (u === "https://dl.example/file.srt") return new Response(SRT);
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const os_ = new OpenSubtitles({ apiKey: "key", username: "jake", password: "pw", dir: subs }, fake);
    const library = new Library([media], 60_000, subs);
    const [item] = await library.list();
    const results = await os_.search({ ...item, meta: { tmdbId: 289, title: "Casablanca", year: 1942, overview: null, posterPath: null } } as MediaItem, path.join(media, "Casablanca (1942).mp4"));
    assert.deepEqual(
      results.map((r) => [r.fileId, r.hashMatch, r.hearingImpaired]),
      [
        [2, true, false],
        [4, false, true],
        [1, false, false],
      ],
    );
    const search = new URL(calls.find((c) => c.url.includes("/subtitles?"))!.url);
    assert.equal(search.searchParams.get("tmdb_id"), "289");
    assert.equal(search.searchParams.get("languages"), "en");
    assert.match(search.searchParams.get("moviehash") ?? "", /^[0-9a-f]{16}$/);
    assert.equal(os_.remaining, 20);

    await os_.download(item.id, 2);
    assert.equal(os_.remaining, 19);
    const dl = calls.find((c) => c.url.endsWith("/download"))!;
    assert.equal((dl.init?.headers as Record<string, string>).Authorization, "Bearer tok");
    assert.equal(await fs.readFile(downloadedFile(subs, item.id), "utf8"), SRT);
    await library.scan();
    const [after] = await library.list();
    assert.deepEqual(after.subtitles, [{ index: 0, label: "English", lang: "en" }]);
    assert.equal(library.peek(item.id)!.subtitlePaths[0], downloadedFile(subs, item.id));
    assert.deepEqual(await fs.readdir(media), ["Casablanca (1942).mp4"], "nothing written beside the video");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a download that isn't a subtitle file is not saved", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-os-"));
  try {
    const fake = (async (url: string | URL | Request) =>
      String(url).endsWith("/download") ? Response.json({ link: "https://dl.example/x", remaining: 5 }) : new Response("<html>Too many requests</html>")) as typeof fetch;
    const os_ = new OpenSubtitles({ apiKey: "key", dir }, fake);
    await assert.rejects(os_.download("abc", 7), /wasn't a subtitle file/);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
