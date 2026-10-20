import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { MediaInfo, MediaItem } from "../../shared/protocol.ts";
import { checkFile, findBlank, Health } from "../src/health.ts";

const MB = 1024 * 1024;
/** Video-like bytes (never 64 KB of zeros), with [blank] (fractions) zeroed out. */
function bytes(size: number, blank?: [number, number]): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 2654435761) >>> 24 || 1;
  if (blank) buf.fill(0, Math.floor(blank[0] * size), Math.floor(blank[1] * size));
  return buf;
}
const info = (width: number, height: number, duration = 2400): MediaInfo => ({ container: "matroska", duration, video: { codec: "h264", width, height, pixFmt: "yuv420p" }, audio: null, convert: true, subtitles: [] });

async function withFiles(fn: (write: (name: string, data: Buffer) => Promise<string>) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-health-"));
  try {
    await fn(async (name, data) => {
      const file = path.join(dir, name);
      await fs.writeFile(file, data);
      return file;
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("a blank stretch is found and placed within a few seconds, including one that runs to the end", async () => {
  await withFiles(async (write) => {
    const size = 40 * MB;
    const end = await write("end.mkv", bytes(size, [0.78, 1]));
    const found = await findBlank(end, size);
    assert.ok(found && found !== "all");
    assert.ok(Math.abs(found.from - 0.78) < 0.002, String(found.from));
    assert.equal(found.to, 1);
    assert.deepEqual(await checkFile(end, size, info(1920, 1080)), { kind: "damaged", detail: "Blank from about 31:13 to the end" });

    const middle = await write("middle.mkv", bytes(size, [0.5, 0.6]));
    const issue = await checkFile(middle, size, info(1920, 1080));
    assert.deepEqual(issue, { kind: "damaged", detail: "Blank from about 20:00 to about 23:58" });

    assert.equal(await findBlank(await write("fine.mkv", bytes(size)), size), null);
    // Padding at the very start isn't damage.
    assert.equal(await findBlank(await write("pad.mkv", bytes(size, [0.001, 0.009])), size), null);
  });
});

test("empty, blank and unreadable files won't play; small pictures are low resolution, widescreen 720p isn't", async () => {
  await withFiles(async (write) => {
    assert.deepEqual(await checkFile(await write("empty.mkv", Buffer.alloc(0)), 0, null), { kind: "broken", detail: "Empty file (0 bytes)" });
    assert.deepEqual(await checkFile(await write("zeros.mkv", Buffer.alloc(4 * MB)), 4 * MB, null), { kind: "broken", detail: "Blank file (all zeros)" });
    const fine = await write("fine.avi", bytes(4 * MB));
    assert.deepEqual(await checkFile(fine, 4 * MB, null), { kind: "broken", detail: "The server can't read it" });
    assert.deepEqual(await checkFile(fine, 4 * MB, info(640, 480)), { kind: "lowres", detail: "480p (640×480)" });
    assert.equal(await checkFile(fine, 4 * MB, info(1280, 536)), null);
    assert.equal(await checkFile(fine, 4 * MB, info(1920, 1080)), null);
  });
});

test("Library health checks each file once, again when it changes, and forgets removed ones", async () => {
  await withFiles(async (write) => {
    const a = await write("a.mkv", Buffer.alloc(0));
    const b = await write("b.mkv", bytes(MB));
    const item = (id: string, size: number, addedAt = 1): MediaItem => ({ id, title: id, relPath: `${id}.mkv`, folder: "", size, mime: "video/x-matroska", subtitles: [], addedAt }) as MediaItem;
    let probes = 0;
    const file = path.join(path.dirname(a), "health.json");
    const health = new Health(file, async () => (probes++, info(1920, 1080)), () => 1000);
    await health.check([{ absPath: a, item: item("a", 0) }, { absPath: b, item: item("b", MB) }]);
    assert.deepEqual(health.report(), { issues: [{ id: "a", relPath: "a.mkv", path: a, kind: "broken", detail: "Empty file (0 bytes)" }], checked: 2, total: 2, checkedAt: 1000 });
    assert.equal(probes, 1, "no probe for an empty file");
    // Saved: a restart doesn't check again; a changed file is.
    const again = new Health(file, async () => (probes++, info(640, 360)));
    await again.check([{ absPath: a, item: item("a", 0) }, { absPath: b, item: item("b", MB, 2) }]);
    assert.equal(probes, 2);
    assert.deepEqual(again.report().issues.map((i) => i.detail), ["Empty file (0 bytes)", "360p (640×360)"]);
    await again.check([{ absPath: b, item: item("b", MB, 2) }]);
    assert.deepEqual(again.report().issues.map((i) => i.id), ["b"]);
  });
});
