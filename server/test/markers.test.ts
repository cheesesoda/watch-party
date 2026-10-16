import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { MediaItem } from "../../shared/protocol.ts";
import { Library } from "../src/library.ts";
import { blackCredits, cardsBefore, chapterMarks, creditsBefore, creditsBeforeExtras, findClip, findRecap, handSet, introChapter, lastChapter, Markers, onCards, outroStart, POINT_SECONDS, recurring, sharedStretch } from "../src/markers.ts";

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

test("an intro heard in part runs on to the end of the chapter it opens", () => {
  // Game of Thrones S1E09: sound finds 0:00-1:03 of titles that are chapter 2, 0:06-1:48, after the HBO logo.
  const chapters = [
    { start: 0, end: 6, title: "" },
    { start: 6, end: 108, title: "" },
    { start: 108, end: 900, title: "" },
  ];
  assert.deepEqual(introChapter({ start: 0, end: 63 }, chapters), { start: 0, end: 108 });
  // Run on already: the same again, so the check for sound few episodes share leaves it alone.
  assert.deepEqual(introChapter({ start: 0, end: 108 }, chapters), { start: 0, end: 108 });
  // Too little of the chapter heard, or a chapter that starts far from it: left as sound found it.
  assert.equal(introChapter({ start: 0, end: 30 }, chapters), null);
  assert.equal(introChapter({ start: 40, end: 100 }, chapters), null);
  // A chapter longer than any intro is a scene, not the titles.
  assert.equal(introChapter({ start: 108, end: 300 }, chapters), null);
  assert.equal(introChapter({ start: 0, end: 63 }, []), null);
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

test("back-to-back chapters join, and a Previously On too short to press is left to detection (Reacher's)", () => {
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
  // The 4 s "Previously On" chapter is gone before anyone could press it (the recap really runs to 0:58): no length
  // is assumed from the chapters around it; matching against earlier episodes finds it instead.
  assert.deepEqual(marks, { intro: { start: 662, end: 675 }, credits: 3031 });
});

test("a recap is the run of clips from earlier episodes at the start, however long, minus what every episode has", () => {
  const scene1 = points(11, seconds(60));
  const scene2 = points(12, seconds(60));
  const logo = points(13, seconds(6));
  const earlier = Uint32Array.from([...logo, ...scene1, ...points(14, seconds(100)), ...scene2, ...points(15, seconds(60))]);
  // Narration, 15 s of scene 2, more narration, 12 s of scene 1, then the logo and the new episode.
  const head = Uint32Array.from([
    ...points(21, seconds(3)), ...scene2.slice(seconds(20), seconds(35)), ...points(22, seconds(5)), ...scene1.slice(seconds(10), seconds(22)),
    ...logo, ...points(23, seconds(200)),
  ]);
  const later = Uint32Array.from([...points(31, seconds(30)), ...logo, ...points(32, seconds(100))]);
  const shared = recurring(head, [earlier, later]);
  // The logo is in both other episodes; the recap's clips only in one.
  assert.equal(shared.length, 1, JSON.stringify(shared));
  assert.ok(Math.abs(shared[0].start - 35) < 1 && Math.abs(shared[0].end - 41) < 1, JSON.stringify(shared));
  const recap = findRecap(head, shared, [{ points: earlier, from: 0, ignore: (t) => t < 15 }]);
  assert.ok(recap && Math.abs(recap.start - 3) < 1 && Math.abs(recap.end - 35) < 1, JSON.stringify(recap));
  // Without the logo ruled out it would run on into it.
  assert.ok(findRecap(head, [], [{ points: earlier, from: 0, ignore: () => false }])!.end > 38);
  // A cold open that never played before is no recap, nor is a single short callback.
  assert.equal(findRecap(Uint32Array.from(points(40, seconds(200))), [], [{ points: earlier, from: 0, ignore: () => false }]), null);
  const callback = Uint32Array.from([...points(41, seconds(60)), ...scene1.slice(0, seconds(5)), ...points(42, seconds(100))]);
  assert.equal(findRecap(callback, [], [{ points: earlier, from: 0, ignore: () => false }]), null);
  // Silence matches any other quiet stretch; it isn't a clip.
  const quiet = new Array(seconds(20)).fill(0);
  assert.equal(findRecap(Uint32Array.from([...quiet, ...points(43, seconds(100))]), [], [{ points: Uint32Array.from([...points(44, 50), ...quiet]), from: 0, ignore: () => false }]), null);
});

test("a known outro is found even when no point matches exactly, and a short piece of it will do", () => {
  const outro = points(77, seconds(30));
  // Every point a bit or two off, as can happen between two encodes: nothing for sharedStretch to start from.
  const reencoded = outro.map((p, i) => (p ^ (i % 2 ? 0b1 : 0b110)) >>> 0);
  const tail = Uint32Array.from([...points(5, seconds(200)), ...reencoded.slice(0, seconds(12)), ...points(6, seconds(3))]);
  assert.equal(sharedStretch(tail, Uint32Array.from(outro), 10), null);
  const hit = findClip(tail, Uint32Array.from(outro), 10);
  assert.ok(hit && Math.abs(hit.start - 200) < 0.5 && Math.abs(hit.end - 212) < 0.5, JSON.stringify(hit));
  assert.equal(findClip(tail, Uint32Array.from(outro), 15), null, "shorter than asked for");
  assert.equal(findClip(Uint32Array.from(points(8, seconds(200))), Uint32Array.from(outro), 10), null);
  assert.ok(hit!.from < 0.5, "it's the outro's start");
  // Only the end of the outro (the logos) plays: it's found, and it says how far into the outro it is.
  const logos = Uint32Array.from([...points(9, seconds(200)), ...outro.slice(seconds(20)), ...points(10, seconds(3))]);
  const late = findClip(logos, Uint32Array.from(outro), 8);
  assert.ok(late && Math.abs(late.start - 200) < 0.5 && Math.abs(late.from - 20) < 0.5, JSON.stringify(late));
});

test("credits before known end logos: walking back through mostly dark keyframes", () => {
  const frames = (spec: [number, number, number][]) =>
    spec.flatMap(([from, to, black]) => Array.from({ length: (to - from) / 2 }, (_, k) => ({ t: from + k * 2, black })));
  // Cards over a dim scene (60-75% black, too little for blackCredits), one brighter card, then the logos at 160.
  const song = frames([[0, 120, 15], [120, 140, 70], [140, 142, 30], [142, 160, 62], [160, 170, 20]]);
  assert.equal(blackCredits(song, 170), null);
  assert.equal(creditsBefore(song, 160), 120);
  // Nothing dark right before the logos, or too short a stretch: no credits.
  assert.equal(creditsBefore(frames([[0, 120, 70], [120, 160, 15]]), 160), null);
  assert.equal(creditsBefore(frames([[0, 154, 15], [154, 160, 80]]), 160), null);
});

test("credits by sound start at the earliest outro the episode shares", () => {
  // Archer S1E03: E02 shares only the last 16 s of its outro, E04 and E05 share it from 1205.6 on.
  assert.equal(outroStart([{ start: 1216.3, length: 16 }, { start: 1205.6, length: 40 }, { start: 1209.4, length: 36 }]), 1205.6);
  // A short early match isn't trusted over longer ones; on its own it still counts.
  assert.equal(outroStart([{ start: 1100, length: 15 }, { start: 1205.6, length: 40 }]), 1205.6);
  assert.equal(outroStart([{ start: 1216.3, length: 16 }]), 1216.3);
  assert.equal(outroStart([]), null);
});

test("credits found by sound move back to where the cards already showing there start", () => {
  // Two frames a second.
  const frames = (spec: [number, number, number][]) =>
    spec.flatMap(([from, to, black]) => Array.from({ length: (to - from) * 2 }, (_, k) => ({ t: from + k / 2, black })));
  // Archer S1E03: a bright scene, cards (~58% black) from 32 s, the outro music heard only from 60.3 s.
  const late = frames([[0, 32, 5], [32, 62, 58]]);
  assert.equal(cardsBefore(late, 60.3), 32);
  // A brighter frame or two among the cards doesn't end them.
  assert.equal(cardsBefore(frames([[0, 32, 5], [32, 45, 58], [45, 46, 30], [46, 62, 58]]), 60.3), 32);
  // The music starts with the cards: stays put.
  assert.equal(cardsBefore(frames([[0, 59.5, 8], [59.5, 62, 58]]), 60.3), null);
  // Not on cards at the mark, or dark all the way back (can't tell a dark scene from cards): stays put.
  assert.equal(cardsBefore(frames([[0, 32, 58], [32, 62, 5]]), 60.3), null);
  assert.equal(cardsBefore(frames([[0, 62, 58]]), 60.3), null);
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
  // Reacher: a bright studio logo after the credits, then black; keyframes out of order and, over still cards, far apart.
  const reacher = [
    { t: 0, black: 10 }, { t: 40, black: 20 }, { t: 70, black: 15 },
    { t: 104, black: 97 }, { t: 98, black: 96 }, { t: 130, black: 98 }, { t: 161, black: 97 }, { t: 185, black: 96 },
    { t: 196, black: 5 }, { t: 200, black: 12 }, { t: 205, black: 100 },
  ];
  assert.equal(blackCredits(reacher, 208), null, "the old 12 s gap rule cuts it");
  assert.equal(blackCredits(reacher, 208, 40), 98);
  // Two frames a second: a 3 s picture card inside is fine, a longer bright scene isn't.
  const half = (spec: [number, number, number][]) =>
    spec.flatMap(([from, to, black]) => Array.from({ length: (to - from) * 2 }, (_, k) => ({ t: from + k / 2, black })));
  assert.equal(blackCredits(half([[0, 50, 10], [50, 80, 95], [80, 83, 30], [83, 140, 96]]), 140, 12, 8), 50);
  assert.equal(blackCredits(half([[0, 50, 10], [50, 80, 95], [80, 90, 30], [90, 140, 96]]), 140, 12, 8), 90);
  // A card full of names reads 83% black for 6 s (Reacher S1E03): too bright at 85, part of the credits at 80. The dark
  // final scene before (72%) stays out.
  const names = half([[0, 30, 10], [30, 50, 72], [50, 80, 95], [80, 86, 83], [86, 140, 96]]);
  assert.equal(blackCredits(names, 140, 12, 8), 86);
  assert.equal(blackCredits(names, 140, 12, 8, 80), 50);
});

test("an unnamed last chapter near the end may be the credits, and credits can come before bonus material", () => {
  const ch = (spec: [number, number, string][]) => spec.map(([start, end, title]) => ({ start, end, title }));
  // Game of Thrones: numbered chapters, the last one the 1:20 of credits.
  const got = ch([[0, 107, "Chapter 1"], [107, 900, "Chapter 2"], [900, 3050, "Chapter 3"], [3050, 3130, "Chapter 4"]]);
  assert.equal(lastChapter(got, 3130), 3050);
  assert.equal(lastChapter(ch([[0, 107, "01"], [107, 3050, "02"], [3050, 3130, "00:50:50.000"]]), 3130), 3050);
  // Named chapters say what they are; too few, too far from the end, or too short to be credits say nothing.
  assert.equal(lastChapter(ch([[0, 107, "Opening"], [107, 3050, "Chapter 2"], [3050, 3130, "Chapter 3"]]), 3130), null);
  assert.equal(lastChapter(ch([[0, 3050, "Chapter 1"], [3050, 3130, "Chapter 2"]]), 3130), null);
  assert.equal(lastChapter(ch([[0, 107, "Chapter 1"], [107, 2800, "Chapter 2"], [2800, 3130, "Chapter 3"]]), 3130), null);
  assert.equal(lastChapter(ch([[0, 107, "Chapter 1"], [107, 3100, "Chapter 2"], [3100, 3130, "Chapter 3"]]), 3130), null);
  // Cards from where it starts: most frames nearly all black.
  const half = (spec: [number, number, number][]) =>
    spec.flatMap(([from, to, black]) => Array.from({ length: (to - from) * 2 }, (_, k) => ({ t: from + k / 2, black })));
  assert.ok(onCards(half([[0, 1, 40], [1, 10, 96]])));
  assert.ok(!onCards(half([[0, 10, 60]])), "a dark scene isn't cards");
  assert.ok(!onCards([]));
  // Keyframes: credits (60 s black), then 8 minutes of interviews with a dark shot or two in them.
  const keys = (spec: [number, number, number][]) =>
    spec.flatMap(([from, to, black]) => Array.from({ length: (to - from) / 4 }, (_, k) => ({ t: from + k * 4, black })));
  assert.equal(creditsBeforeExtras(keys([[0, 300, 10], [300, 360, 96], [360, 840, 20], [600, 612, 96]]), 840), 300);
  // Black at the very end is the usual credits, not these; nor is a short dark stretch.
  assert.equal(creditsBeforeExtras(keys([[0, 700, 10], [700, 840, 96]]), 840), null);
  assert.equal(creditsBeforeExtras(keys([[0, 300, 10], [300, 320, 96], [320, 840, 20]]), 840), null);
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
  assert.ok(lines.some((l) => l.includes("Show season 1: intros in 2 of 2, recaps in 0, credits in 2")), lines.join("\n"));
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
  // Only the recap check ran (nothing to recap here); intros and credits weren't listened for again.
  assert.ok(lines.some((l) => l.includes("Show season 1: intros in 2 of 2, recaps in 0, credits in 2")), lines.join("\n"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("credits from an unnamed last chapter on cards, true black only by the picture, and before bonus material", { skip: !canFingerprint && "needs ffmpeg with chromaprint" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marks-end-"));
  const season = path.join(dir, "Show", "Season 1");
  await fs.mkdir(season, { recursive: true });
  // 320 s: picture until 200 s, a night scene (nearly black, not quite) until 260 s, then white lines on true black.
  // E01's chapters are numbered, the last one the credits; E02 has none.
  const meta = path.join(dir, "chapters.txt");
  await fs.writeFile(meta, ";FFMETADATA1\n" + [[0, 100000, "Chapter 1"], [100000, 260000, "Chapter 2"], [260000, 320000, "Chapter 3"]].map(([s, e, t]) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${s}\nEND=${e}\ntitle=${t}\n`).join(""));
  const make = (out: string, seed: number, chapters: boolean) => {
    const r = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=8:d=200",
      "-f", "lavfi", "-i", "color=0x0a0a0a:s=320x180:r=8:d=60",
      "-f", "lavfi", "-i", "color=black:s=320x180:r=8:d=60",
      "-f", "lavfi", "-i", melody(seed, 320),
      ...(chapters ? ["-i", meta] : []),
      "-filter_complex", "[1:v]drawbox=x=140:y=60:w=40:h=30:color=0x101010:t=fill[n];[2:v]drawbox=x=100:y=40:w=120:h=6:color=white:t=fill,drawbox=x=120:y=90:w=80:h=6:color=white:t=fill[c];[0:v][n][c]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-map", "3:a", ...(chapters ? ["-map_metadata", "4"] : []), "-g", "16", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      out,
    ]);
    assert.equal(r.status, 0, r.stderr?.toString());
  };
  make(path.join(season, "Show S01E01.mkv"), 2.1, true);
  make(path.join(season, "Show S01E02.mkv"), 7.7, false);
  const library = new Library([dir]);
  await library.scan();
  const eps = (await library.list()).filter((i) => i.episode).sort((a, b) => a.episode!.episode - b.episode!.episode);
  const entries = eps.map((item) => ({ absPath: library.peek(item.id)!.absPath, item }));
  const file = path.join(dir, "markers.json");
  const markers = new Markers({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", file }, () => {});
  await markers.warm(entries);
  assert.equal(markers.get(eps[0])?.credits, 260, JSON.stringify(markers.get(eps[0])));
  const second = markers.get(eps[1])?.credits;
  assert.ok(second != null && second >= 260 && second <= 262.5, `E02 credits ${second}: the night scene isn't cards`);

  // Found before by the picture at the old black (in the night scene): checked once again, and moved.
  const old = await (markers as unknown as { pictureCredits(f: string, d: number, t: number, b: number): Promise<number | null> }).pictureCredits(entries[1].absPath, 320, 256, 32);
  assert.ok(old != null && old < 259, `old black found ${old}`);
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  for (const [n, ep] of eps.entries()) {
    const e = saved.files[ep.id];
    saved.files[ep.id] = { ...e, marks: { ...e.marks, credits: n === 0 ? null : old }, ends: undefined };
  }
  await fs.writeFile(file, JSON.stringify(saved));
  const lines: string[] = [];
  const again = new Markers({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", file }, (l) => lines.push(l));
  await again.warm(entries);
  assert.equal(again.get(eps[0])?.credits, 260, lines.join("\n") + JSON.stringify(again.get(eps[0])));
  const moved = again.get(eps[1])?.credits;
  assert.ok(moved != null && moved >= 260 && moved <= 262.5, `moved to ${moved}`);
  assert.ok(lines.some((l) => l.startsWith("checked the credits again in 2 episodes (2 changed)")), lines.join("\n"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("credits followed by bonus material are found before it", { skip: !canFingerprint && "needs ffmpeg with chromaprint" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marks-extra-"));
  const season = path.join(dir, "Show", "Season 1");
  await fs.mkdir(season, { recursive: true });
  // 40 minutes: the episode until 31:00, a minute of credits on black, then 8 minutes of interviews.
  const r = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=160x90:r=2:d=1860",
    "-f", "lavfi", "-i", "color=black:s=160x90:r=2:d=60",
    "-f", "lavfi", "-i", "testsrc=s=160x90:r=2:d=480",
    "-f", "lavfi", "-i", melody(3.3, 2400),
    "-filter_complex", "[1:v]drawbox=x=50:y=20:w=60:h=4:color=white:t=fill[c];[0:v][c][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-map", "3:a", "-g", "4", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "32k",
    path.join(season, "Show S01E01.mkv"),
  ]);
  assert.equal(r.status, 0, r.stderr?.toString());
  const library = new Library([dir]);
  await library.scan();
  const eps = (await library.list()).filter((i) => i.episode);
  const markers = new Markers({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", file: "" }, () => {});
  await markers.warm(eps.map((item) => ({ absPath: library.peek(item.id)!.absPath, item })));
  const credits = markers.get(eps[0])?.credits;
  assert.ok(credits != null && credits >= 1859 && credits <= 1861, `credits ${credits}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test("finds recaps in real files by matching earlier episodes, ending where the clips do", { skip: !canFingerprint && "needs ffmpeg with chromaprint" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marks-recap-"));
  const season = path.join(dir, "Show", "Season 1");
  await fs.mkdir(season, { recursive: true });
  // The sounds the episodes are cut from, so a recap can reuse an exact piece of an earlier episode.
  const sounds: Record<string, string> = {};
  const make = async (name: string, seed: number, length: number) => {
    sounds[name] = path.join(dir, `${name}.wav`);
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", melody(seed, length), sounds[name]]);
    assert.equal(r.status, 0, r.stderr?.toString());
  };
  for (const [name, seed, length] of [
    ["logo", 1.7, 6], ["credits", 9.9, 30], ["a1", 2.1, 40], ["a2", 2.9, 40], ["a3", 3.7, 200],
    ["b1", 4.3, 250], ["c1", 5.9, 250], ["n1", 6.1, 3], ["n2", 6.7, 5], ["n3", 7.3, 3], ["n4", 7.9, 4],
  ] as const) await make(name, seed, length);
  const episode = (n: number, pieces: [string, number, number][]) => {
    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    for (const [name, from, length] of pieces) args.push("-ss", String(from), "-t", String(length), "-i", sounds[name]);
    args.push("-filter_complex", `${pieces.map((_, i) => `[${i}:a]`).join("")}concat=n=${pieces.length}:v=0:a=1[a]`, "-map", "[a]", "-c:a", "aac", path.join(season, `Show S01E0${n}.mp4`));
    const r = spawnSync("ffmpeg", args);
    assert.equal(r.status, 0, r.stderr?.toString());
  };
  // Episode 1: logo, its story, credits. No recap.
  episode(1, [["logo", 0, 6], ["a1", 0, 40], ["a2", 0, 40], ["a3", 0, 200], ["credits", 0, 30]]);
  // Episode 2: narration, 15 s of episode 1's a2, narration, 15 s of a1 (recap 0:03 to 0:38), then the logo.
  episode(2, [["n1", 0, 3], ["a2", 10, 15], ["n2", 0, 5], ["a1", 5, 15], ["logo", 0, 6], ["b1", 0, 250], ["credits", 0, 30]]);
  // Episode 3: narration, 20 s of episode 2's story, narration, 12 s of episode 1's opening (recap 0:03 to 0:38).
  episode(3, [["n3", 0, 3], ["b1", 20, 20], ["n4", 0, 3], ["a1", 25, 12], ["logo", 0, 6], ["c1", 0, 250], ["credits", 0, 30]]);

  const library = new Library([dir]);
  await library.scan();
  const eps = (await library.list()).filter((i) => i.episode);
  const lines: string[] = [];
  const markers = new Markers({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", file: path.join(dir, "markers.json") }, (l) => lines.push(l));
  await markers.warm(eps.map((item) => ({ absPath: library.peek(item.id)!.absPath, item })));
  assert.equal(markers.get(eps[0])?.recap ?? null, null);
  for (const ep of eps.slice(1)) {
    const marks = markers.get(ep);
    const recap = marks?.recap;
    assert.ok(recap && Math.abs(recap.start - 3) < 3 && Math.abs(recap.end - 38) < 3, `${ep.relPath}: ${JSON.stringify(marks)}`);
    // The recap's clips aren't mistaken for an intro (they're in one other episode, not most).
    assert.equal(marks?.intro ?? null, null, `${ep.relPath}: ${JSON.stringify(marks)}`);
  }
  assert.equal(markers.get(eps[0])?.intro ?? null, null, JSON.stringify(markers.get(eps[0])));
  assert.ok(lines.some((l) => l.includes("Show season 1: intros in 0 of 3, recaps in 2, credits in 3")), lines.join("\n"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("an episode whose outro is too short to find by comparing endings gets it from the episodes that have it", { skip: !canFingerprint && "needs ffmpeg with chromaprint" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marks-outro-"));
  const season = path.join(dir, "Show", "Season 1");
  await fs.mkdir(season, { recursive: true });
  // Episodes 1 and 2 end with the 30 s outro; episode 3 cuts it to 12 s, then a 5 s tag scene.
  const story = (n: number, length: number) => ["-f", "lavfi", "-i", melody(n * 3.1 + 0.4, length)];
  const pieces: Record<number, string[]> = {
    1: [...story(1, 250), "-f", "lavfi", "-i", melody(8.8, 30)],
    2: [...story(2, 250), "-f", "lavfi", "-i", melody(8.8, 30)],
    3: [...story(3, 260), "-f", "lavfi", "-i", melody(8.8, 12), ...story(4, 5)],
  };
  for (const n of [1, 2, 3]) {
    const inputs = pieces[n].filter((a) => a === "-i").length;
    const r = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", ...pieces[n],
      "-filter_complex", `${Array.from({ length: inputs }, (_, i) => `[${i}:a]`).join("")}concat=n=${inputs}:v=0:a=1[a]`,
      "-map", "[a]", "-c:a", "aac", path.join(season, `Show S01E0${n}.mp4`),
    ]);
    assert.equal(r.status, 0, r.stderr?.toString());
  }
  const library = new Library([dir]);
  await library.scan();
  const eps = (await library.list()).filter((i) => i.episode);
  const lines: string[] = [];
  const markers = new Markers({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", file: path.join(dir, "markers.json") }, (l) => lines.push(l));
  await markers.warm(eps.map((item) => ({ absPath: library.peek(item.id)!.absPath, item })));
  const credits = eps.map((ep) => markers.get(ep)?.credits);
  assert.ok(credits[0] != null && Math.abs(credits[0] - 250) < 4, JSON.stringify(credits));
  assert.ok(credits[2] != null && Math.abs(credits[2] - 260) < 4, JSON.stringify(credits));
  assert.ok(lines.some((l) => l.includes("credits in 3")), lines.join("\n"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("skip times set by hand go over what was found, kind by kind, and stay through looking again", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hand-"));
  const file = path.join(dir, "markers.json");
  const handFile = path.join(dir, "skip-times.json");
  const item = { id: "a", relPath: "Show/S01E01.mkv", size: 1, addedAt: 0 } as unknown as MediaItem;
  await fs.writeFile(file, JSON.stringify({ files: { a: { key: "1:0", v: 2, marks: { intro: { start: 0, end: 30 }, recap: null, credits: 1200 }, peers: 2 } } }));
  const markers = new Markers({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", file, handFile }, () => {});
  await markers.setHand(item, { intro: { start: 0, end: 108 } });
  // The intro set by hand, the credits still as found.
  assert.deepEqual(markers.get(item), { intro: { start: 0, end: 108 }, recap: null, credits: 1200 });
  assert.deepEqual(markers.found(item)?.intro, { start: 0, end: 30 });
  const saved = JSON.parse(await fs.readFile(handFile, "utf8"));
  assert.deepEqual(saved, { a: { file: "Show/S01E01.mkv", intro: { start: 0, end: 108 } } });

  // Edited by hand: read again without a restart (null: no credits at all).
  await fs.writeFile(handFile, JSON.stringify({ a: { ...saved.a, credits: null } }));
  await fs.utimes(handFile, new Date(), new Date(Date.now() + 2000));
  await (markers as unknown as { loadHand(): Promise<void> }).loadHand();
  assert.equal(markers.get(item)?.credits, null);

  // After a restart too; and back to what was found when they're cleared.
  const again = new Markers({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", file, handFile }, () => {});
  await again.setHand(item, null);
  assert.deepEqual(again.get(item), { intro: { start: 0, end: 30 }, recap: null, credits: 1200 });
  await markers.close();
  await again.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("skip times set by hand have to make sense", () => {
  assert.deepEqual(handSet({ intro: { start: 7, end: 108.04 }, credits: null }), { intro: { start: 7, end: 108 }, credits: null });
  assert.equal(handSet({ intro: { start: 108, end: 7 } }), null);
  assert.equal(handSet({ credits: -1 }), null);
  assert.equal(handSet("intro"), null);
});
