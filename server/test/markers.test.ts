import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Library } from "../src/library.ts";
import { chapterMarks, Markers, POINT_SECONDS, sharedStretch } from "../src/markers.ts";

/** Pseudo-random fingerprint points, the same for the same seed. */
function points(seed: number, n: number): number[] {
  let x = seed >>> 0 || 1;
  return Array.from({ length: n }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  });
}

const seconds = (s: number) => Math.round(s / POINT_SECONDS);

test("finds the theme two episodes share, wherever it sits in each", () => {
  const theme = points(7, seconds(40));
  // A few points differ slightly, as two encodes of the same sound do.
  const noisy = theme.map((p, i) => (i % 9 === 0 ? (p ^ 0b101) >>> 0 : p));
  const a = Uint32Array.from([...points(1, seconds(20)), ...theme, ...points(2, seconds(100))]);
  const b = Uint32Array.from([...points(3, seconds(65)), ...noisy, ...points(4, seconds(60))]);
  const hit = sharedStretch(a, b, 15, 150);
  assert.ok(hit);
  assert.ok(Math.abs(hit.a.start - 20) < 0.5 && Math.abs(hit.a.end - 60) < 0.5, JSON.stringify(hit));
  assert.ok(Math.abs(hit.b.start - 65) < 0.5 && Math.abs(hit.b.end - 105) < 0.5, JSON.stringify(hit));
});

test("nothing shared, or too short or long a stretch, is no intro", () => {
  const a = Uint32Array.from(points(1, seconds(120)));
  const b = Uint32Array.from(points(2, seconds(120)));
  assert.equal(sharedStretch(a, b, 15), null);
  const short = points(9, seconds(8));
  assert.equal(sharedStretch(Uint32Array.from([...points(1, 100), ...short]), Uint32Array.from([...short, ...points(2, 100)]), 15), null);
  const long = points(9, seconds(200));
  assert.equal(sharedStretch(Uint32Array.from(long), Uint32Array.from(long), 15, 150), null);
});

test("chapter names mark the intro, recap and credits", () => {
  const marks = chapterMarks([
    { start: 0, end: 62.4, title: "Previously on…" },
    { start: 62.4, end: 120, title: "Chapter 2" },
    { start: 120, end: 171.25, title: "Opening" },
    { start: 171.25, end: 2500, title: "Chapter 4" },
    { start: 2500, end: 2600, title: "End Credits" },
  ]);
  assert.deepEqual(marks, { recap: { start: 0, end: 62.4 }, intro: { start: 120, end: 171.3 }, credits: 2500 });
  assert.deepEqual(chapterMarks([{ start: 0, end: 10, title: "Chapter 1" }]), {});
});

const canFingerprint =
  spawnSync("ffmpeg", ["-hide_banner", "-muxers"]).stdout?.toString().includes("chromaprint") && spawnSync("ffprobe", ["-version"]).status === 0;

/** A made-up melody: tones that change four times a second, different for each [seed]. */
const melody = (seed: number, seconds: number) =>
  `aevalsrc='0.35*sin(2*PI*(200+500*abs(sin(floor(t*4)*12.9898*${seed})))*t)+0.25*sin(2*PI*(500+700*abs(sin(floor(t*3)*78.233*${seed})))*t)':d=${seconds}:s=44100`;

test("finds a season's intros and credits in real files, and a movie's from its chapters", { skip: !canFingerprint && "needs ffmpeg with chromaprint" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marks-"));
  const season = path.join(dir, "Show", "Season 1");
  await fs.mkdir(season, { recursive: true });
  // Each episode: its own cold open, the shared theme, its own story (long enough that the theme is in its first
  // quarter), then the shared credits.
  const truth: { intro: number; credits: number }[] = [];
  for (const n of [1, 2]) {
    const open = 20 + n * 15;
    truth.push({ intro: open, credits: open + 30 + 200 });
    const r = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", melody(n * 7 + 0.13, open),
      "-f", "lavfi", "-i", melody(3.3, 30),
      "-f", "lavfi", "-i", melody(n * 5 + 0.71, 200),
      "-f", "lavfi", "-i", melody(9.9, 40),
      "-filter_complex", "[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1[a]",
      "-map", "[a]", "-c:a", "aac", "-b:a", `${64 + n * 64}k`, path.join(season, `Show S01E0${n}.mp4`),
    ]);
    assert.equal(r.status, 0, r.stderr?.toString());
  }
  const meta = path.join(dir, "chapters.txt");
  await fs.writeFile(meta, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=50000\ntitle=Chapter 1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=50000\nEND=60000\ntitle=Credits\n");
  const movie = path.join(dir, "Movie (2001).mkv");
  assert.equal(spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", melody(1.1, 60), "-i", meta, "-map_metadata", "1", "-c:a", "aac", movie]).status, 0);

  const library = new Library([dir]);
  await library.scan();
  const items = await library.list();
  const lines: string[] = [];
  const markers = new Markers({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", file: path.join(dir, "markers.json") }, (l) => lines.push(l));
  await markers.warm(items.map((item) => ({ absPath: library.peek(item.id)!.absPath, item })));
  const eps = items.filter((i) => i.episode);
  for (const [i, ep] of eps.entries()) {
    const marks = markers.get(ep);
    assert.ok(marks?.intro && marks.credits != null, `${ep.relPath}: ${JSON.stringify(marks)}`);
    // Chromaprint looks at a couple of seconds at a time, so the edges land within a few seconds.
    assert.ok(Math.abs(marks.intro.start - truth[i].intro) < 6, `${ep.relPath} intro ${JSON.stringify(marks.intro)}`);
    assert.ok(Math.abs(marks.intro.end - (truth[i].intro + 30)) < 3, `${ep.relPath} intro ${JSON.stringify(marks.intro)}`);
    assert.ok(Math.abs(marks.credits - truth[i].credits) < 6, `${ep.relPath} credits ${marks.credits}`);
  }
  assert.ok(lines.some((l) => l.includes("Show season 1: intros in 2 of 2, credits in 2")), lines.join("\n"));
  const film = items.find((i) => !i.episode)!;
  assert.deepEqual(markers.get(film), { credits: 50 });
  assert.equal(markers.attach(film).marks?.credits, 50);

  // Kept on disk, so a restart doesn't look again.
  const again = new Markers({ ffmpeg: "ffmpeg-missing", ffprobe: "ffprobe-missing", file: path.join(dir, "markers.json") }, () => {});
  await again.warm(items.map((item) => ({ absPath: library.peek(item.id)!.absPath, item })));
  assert.deepEqual(again.get(eps[0]), markers.get(eps[0]));
  await fs.rm(dir, { recursive: true, force: true });
});
