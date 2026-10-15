import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ffmpegArgs, parseProbe, playlist, Transcoder } from "../src/transcode.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

test("parseProbe picks the main video and default audio, skipping cover art", () => {
  const info = parseProbe({
    format: { format_name: "matroska,webm", duration: "5400.5" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
      { index: 1, codec_type: "video", codec_name: "hevc", width: 3840, height: 2160, pix_fmt: "yuv420p10le" },
      { index: 2, codec_type: "audio", codec_name: "eac3", channels: 6, disposition: { default: 0 } },
      { index: 3, codec_type: "audio", codec_name: "ac3", channels: 6, disposition: { default: 1 } },
    ],
  });
  assert.equal(info.duration, 5400.5);
  assert.deepEqual(info.video, { codec: "hevc", width: 3840, height: 2160, pixFmt: "yuv420p10le" });
  assert.deepEqual(info.audio, { codec: "ac3", channels: 6 });
  assert.equal(info.videoIndex, 1);
  assert.equal(info.audioIndex, 3);
});

test("parseProbe plays English audio when the file has it, even if another track is the default", () => {
  const probe = (streams: any[]) => parseProbe({ format: { format_name: "matroska", duration: "60" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264" }, ...streams] });
  const dual = probe([
    { index: 1, codec_type: "audio", codec_name: "aac", tags: { language: "jpn" }, disposition: { default: 1 } },
    { index: 2, codec_type: "audio", codec_name: "aac", tags: { language: "eng" }, disposition: { default: 0 } },
  ]);
  assert.equal(dual.audioIndex, 2);
  assert.equal(dual.audioNotFirst, true);
  // English first: browsers can play it as-is.
  const first = probe([
    { index: 1, codec_type: "audio", codec_name: "aac", tags: { language: "en" } },
    { index: 2, codec_type: "audio", codec_name: "aac", tags: { language: "spa" }, disposition: { default: 1 } },
  ]);
  assert.equal(first.audioIndex, 1);
  assert.equal(first.audioNotFirst, false);
  // The main English track, not the commentary; untagged tracks named "English" count.
  const commentary = probe([
    { index: 1, codec_type: "audio", codec_name: "aac", tags: { language: "eng", title: "Director's commentary" } },
    { index: 2, codec_type: "audio", codec_name: "aac", tags: { title: "English 5.1" } },
  ]);
  assert.equal(commentary.audioIndex, 2);
  // No English: the default, as before.
  assert.equal(probe([{ index: 1, codec_type: "audio", codec_name: "aac", tags: { language: "fre" } }, { index: 2, codec_type: "audio", codec_name: "aac", tags: { language: "ger" }, disposition: { default: 1 } }]).audioIndex, 2);
});

test("playlist lists every segment, the last one short", () => {
  const text = playlist(10, 4);
  assert.match(text, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.deepEqual(text.match(/#EXTINF:[\d.]+/g), ["#EXTINF:4.000", "#EXTINF:4.000", "#EXTINF:2.000"]);
  assert.match(text, /2\.ts\n#EXT-X-ENDLIST/);
  assert.equal(playlist(8, 4).match(/#EXTINF/g)?.length, 2);
  // A sliver past the last full segment (often audio padding) stays in that segment.
  assert.deepEqual(playlist(8.02, 4).match(/#EXTINF:[\d.]+/g), ["#EXTINF:4.000", "#EXTINF:4.020"]);
});

test("ffmpegArgs seeks to the segment and keeps its place on the timeline", () => {
  const probe = parseProbe({ format: { format_name: "matroska", duration: "60" }, streams: [{ index: 0, codec_type: "video", codec_name: "hevc" }, { index: 1, codec_type: "audio", codec_name: "ac3" }] });
  const args = ffmpegArgs({ input: "/m/a.mkv", probe, start: 5, outDir: "/tmp/x", encoder: "h264_nvenc", seg: 4 });
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after("-ss"), "20");
  assert.equal(after("-output_ts_offset"), "30");
  assert.equal(after("-start_number"), "5");
  assert.equal(after("-c:v"), "h264_nvenc");
  assert.equal(after("-hwaccel"), "auto");
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss before -i seeks fast");
  const cpu = ffmpegArgs({ input: "/m/a.mkv", probe, start: 0, outDir: "/tmp/x", encoder: "libx264", seg: 4 });
  assert.ok(!cpu.includes("-ss"));
  assert.equal(cpu[cpu.indexOf("-hwaccel") + 1], "auto", "decodes on the GPU when there is one");
  assert.equal(cpu[cpu.indexOf("-c:v") + 1], "libx264");
});

test("converts HEVC + AC3 into segments that line up across restarts", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-tc-"));
  const input = path.join(dir, "in.mkv");
  const made = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24:d=20", "-f", "lavfi", "-i", "sine=d=20", "-ac", "6", "-c:v", "libx265", "-x265-params", "log-level=error", "-preset", "ultrafast", "-c:a", "ac3", input]);
  if (made.status !== 0) return void (await fs.rm(dir, { recursive: true, force: true }));
  const tc = new Transcoder({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", dir: path.join(dir, "out"), encoder: "libx264" });
  try {
    const info = await tc.probe(input);
    assert.equal(info?.video?.codec, "hevc");
    assert.equal(info?.audio?.codec, "ac3");
    assert.equal(info?.convert, true);
    assert.equal((await tc.playlist("m", input))?.match(/#EXTINF/g)?.length, 5);

    // Asking for a later segment first starts a job there; going back starts another at 0.
    const later = await tc.segment("m", input, 3);
    const first = await tc.segment("m", input, 0);
    const second = await tc.segment("m", input, 1);
    const start = (file: string) =>
      Number(spawnSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=start_time", "-of", "csv=p=0", file]).stdout.toString().trim().split("\n")[0]);
    assert.ok(later && first && second);
    assert.ok(Math.abs(start(second) - start(first) - 4) < 0.01, "segment 1 starts 4 s after segment 0");
    assert.ok(Math.abs(start(later) - start(first) - 12) < 0.01, "segment 3 starts 12 s after segment 0, though another job made it");
    assert.equal(await tc.segment("m", input, 5), null, "past the end");
  } finally {
    await tc.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("parseProbe lists text subtitles inside the file, skipping picture-based ones", () => {
  const info = parseProbe({
    format: { format_name: "matroska", duration: "60" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle", tags: { language: "eng" } },
      { index: 2, codec_type: "subtitle", codec_name: "subrip", tags: { language: "dut" }, disposition: { default: 1 } },
      { index: 3, codec_type: "subtitle", codec_name: "ass", tags: { language: "eng", title: "SDH" } },
      { index: 4, codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" }, disposition: { forced: 1 } },
      { index: 5, codec_type: "subtitle", codec_name: "subrip", tags: { language: "und" } },
    ],
  });
  assert.deepEqual(
    info.subtitles.map((s) => s.label),
    ["Dutch", "English (SDH)", "English, forced", "Unknown language"],
  );
  assert.deepEqual(info.subtitleIndexes, [2, 3, 4, 5]);
  assert.equal(info.subtitles[3].lang, null);
});

test("pulls a subtitle track out of the file as WebVTT", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-sub-"));
  try {
    const srt = path.join(dir, "nl.srt");
    await fs.writeFile(srt, "1\n00:00:01,000 --> 00:00:02,500\nHallo daar, één\n\n");
    const input = path.join(dir, "in.mkv");
    const made = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=10:d=4", "-i", srt, "-map", "0", "-map", "1", "-c:v", "mpeg4", "-c:s", "srt", "-metadata:s:s:0", "language=dut", input]);
    if (made.status !== 0) return;
    const tc = new Transcoder({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", dir: path.join(dir, "out"), encoder: "off" });
    const probe = await tc.probe(input);
    assert.deepEqual(probe?.subtitles, [{ index: 0, label: "Dutch", lang: "dut" }]);
    const vtt = await tc.subtitle(input, 0);
    assert.match(vtt ?? "", /^WEBVTT/);
    assert.match(vtt ?? "", /00:0?0?:?01\.000 --> 00:0?0?:?02\.500\nHallo daar, één/);
    assert.equal(await tc.subtitle(input, 1), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("grabs a still from the video for cards without TMDB art", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-frame-"));
  try {
    const input = path.join(dir, "a.mp4");
    const made = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=10:d=20", "-c:v", "mpeg4", input]);
    assert.equal(made.status, 0);
    const tc = new Transcoder({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", dir: path.join(dir, "out"), encoder: "off" });
    const jpg = await tc.frame(input, 12);
    assert.ok(jpg && jpg[0] === 0xff && jpg[1] === 0xd8, "a JPEG");
    // A spot at the start would show a minute in, past the end of this 20 s file: it falls back to the first seconds.
    assert.ok(await tc.frame(input, 0), "a short file still gets a frame");
    assert.equal(await tc.frame(path.join(dir, "missing.mp4"), 12), null);
    await tc.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
