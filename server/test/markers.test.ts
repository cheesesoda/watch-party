import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Library } from "../src/library.ts";
import { blackCredits, chapterMarks, Markers, POINT_SECONDS, sharedStretch } from "../src/markers.ts";

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
  // Too short to press, with nothing to run on to: no button.
  assert.deepEqual(chapterMarks([{ start: 0, end: 4, title: "Intro" }, { start: 4, end: 900, title: "Chapter 2" }]), {});
});

test("back-to-back chapters join, and a short Previously On runs to the studio logo (Reacher's)", () => {
  const marks = chapterMarks([
    { start: 0, end: 6, title: "Studio Logo" },
    { start: 6, end: 10, title: "Previously On" },
    { start: 10, end: 55, title: "Scene 1" },
    { start: 55, end: 60, title: "Scene 2" },
    { start: 60, end: 66, title: "Studio Logo" },
    { start: 66, end: 108, title: "Scene 3" },
    { start: 617, end: 662, title: "Scene 12" },
    { start: 662, end: 667, title: "Title Sequence" },
    { start: 667, end: 675, title: "Opening Credits" },
    { start: 675, end: 785, title: "Scene 13" },
    { start: 3031, end: 3269.183, title: "End Credits" },
  ]);
  // The 4 s "Previously On" runs on to the studio logo at 1:00 (the recap really ends at 0:58).
  assert.deepEqual(marks, { recap: { start: 6, end: 60 }, intro: { start: 662, end: 675 }, credits: 3031 });
});

test("credits by the picture: the last long stretch of black keyframes", () => {
  const frames = (spec: [number, number, number][]) =>
    spec.flatMap(([from, to, black]) => Array.from({ length: (to - from) / 2 }, (_, k) => ({ t: from + k * 2, black })));
  // A story, then credits with one picture card in them, then a bright logo at the very end.
  assert.equal(blackCredits(frames([[0, 100, 10], [100, 130, 95], [130, 132, 40], [132, 172, 95], [172, 180, 20]]), 180), 100);
  // A dark scene just before the credits is kept out by two bright keyframes between them.
  assert.equal(blackCredits(frames([[0, 60, 10], [60, 80, 92], [80, 84, 30], [84, 140, 96]]), 140), 84);
  // No black stretch, or one too short, or one that stops long before the end: no credits.
  assert.equal(blackCredits(frames([[0, 140, 10]]), 140), null);
  assert.equal(blackCredits(frames([[0, 126, 10], [126, 140, 96]]), 140), null);
  assert.equal(blackCredits(frames([[0, 40, 10], [40, 80, 96], [80, 140, 10]]), 140), null);
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

test("finds credits by the picture when the sound doesn't match, and brings version 1 results up to date", { skip: !canFingerprint && "needs ffmpeg with chromaprint" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marks-pic-"));
  const season = path.join(dir, "Show", "Season 1");
  await fs.mkdir(season, { recursive: true });
  // 300 s: picture until 260 s, then white lines on black (the credits); a different song over each episode's credits.
  // Chapters: a "Title Sequence" and an "Opening Credits" back to back.
  const meta = path.join(dir, "chapters.txt");
  await fs.writeFile(meta, ";FFMETADATA1\n" + [[0, 10000, "Scene 1"], [10000, 15000, "Title Sequence"], [15000, 23000, "Opening Credits"], [23000, 300000, "Scene 2"]].map(([s, e, t]) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${s}\nEND=${e}\ntitle=${t}\n`).join(""));
  for (const n of [1, 2]) {
    const r = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=260",
      "-f", "lavfi", "-i", "color=black:s=320x180:r=24:d=40",
      "-f", "lavfi", "-i", melody(n * 4.7 + 0.3, 300),
      "-i", meta,
      "-filter_complex", "[1:v]drawbox=x=100:y=40:w=120:h=6:color=white:t=fill,drawbox=x=120:y=90:w=80:h=6:color=white:t=fill[c];[0:v][c]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-map", "2:a", "-map_metadata", "3", "-g", "48", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      path.join(season, `Show S01E0${n}.mkv`),
    ]);
    assert.equal(r.status, 0, r.stderr?.toString());
  }
  const library = new Library([dir]);
  await library.scan();
  const eps = (await library.list()).filter((i) => i.episode);
  const entries = eps.map((item) => ({ absPath: library.peek(item.id)!.absPath, item }));
  const markers = new Markers({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", file: path.join(dir, "markers.json") }, () => {});
  await markers.warm(entries);
  for (const ep of eps) {
    const marks = markers.get(ep);
    assert.deepEqual(marks?.intro, { start: 10, end: 23 }, `${ep.relPath}: ${JSON.stringify(marks)}`);
    // Keyframes every 2 s, so the switch to black is found within one.
    assert.ok(marks?.credits != null && marks.credits >= 260 && marks.credits <= 262.5, `${ep.relPath} credits ${marks?.credits}`);
  }

  // Version 1 kept only the first intro chapter (5 s) and no credits; the update fixes both without listening again.
  const file = path.join(dir, "v1.json");
  const key = (i: (typeof eps)[number]) => `${i.size}:${i.addedAt ?? 0}`;
  await fs.writeFile(file, JSON.stringify({ files: Object.fromEntries(eps.map((i) => [i.id, { key: key(i), v: 1, marks: { intro: { start: 10, end: 15 }, recap: null, credits: null }, peers: 2 }])) }));
  const lines: string[] = [];
  const upgraded = new Markers({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", file }, (l) => lines.push(l));
  await upgraded.warm(entries);
  for (const ep of eps) {
    const marks = upgraded.get(ep);
    assert.deepEqual(marks?.intro, { start: 10, end: 23 });
    assert.ok(marks?.credits != null && marks.credits >= 260 && marks.credits <= 262.5, `credits ${marks?.credits}`);
  }
  assert.ok(lines.some((l) => l.startsWith("updated 2 earlier results")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("Show season 1")), "listened again: " + lines.join("\n"));
  await fs.rm(dir, { recursive: true, force: true });
});
