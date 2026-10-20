import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { MediaInfo } from "../../shared/protocol.ts";

/** Length of each HLS segment in seconds. Short enough that a seek starts quickly. */
export const SEGMENT_SECONDS = 4;
/** A request this many segments past what the running job has written waits for it instead of restarting it. */
const AHEAD_WINDOW = 8;
/** How long a segment request waits before giving up. */
const SEGMENT_TIMEOUT_MS = 45_000;
/** Converted copies nobody has asked for in this long are stopped and deleted. */
const IDLE_MS = 3 * 60_000;
/**
 * The lighter copy for slow connections: 720p at about 3 Mbps with 128k audio, against 1080p up to 10 Mbps and 192k
 * for the usual converted copy.
 */
export const LIGHT = { height: 720, maxrate: "3M", bufsize: "6M", audio: "128k" };

export interface TranscodeConfig {
  ffmpeg: string;
  ffprobe: string;
  /** Where converted segments are written while a movie is being watched. */
  dir: string;
  /** "auto" picks NVENC when the GPU has it, else libx264; "off" disables converting. */
  encoder: string;
  /** Where files' lengths are kept, so they show right after a restart instead of once each file is probed again. */
  durationsFile?: string;
}

export interface ProbeResult extends MediaInfo {
  videoIndex: number | null;
  audioIndex: number | null;
  /** The stream index of each entry in `audios`. */
  audioIndexes: number[];
  /** The stream index of each entry in `subtitles`. */
  subtitleIndexes: number[];
}

/** Subtitle formats ffmpeg can turn into WebVTT. Picture-based ones (Blu-ray PGS, DVD VobSub) can't be. */
const TEXT_SUBTITLES = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

/** "Dutch", "English (SDH)", "German, forced": the language, then the file's own title for the track when it adds something. */
export function subtitleLabel(lang: string | null, title: string, forced: boolean): string {
  let name = "";
  if (lang) {
    try {
      name = languageNames.of(lang) ?? "";
    } catch {
      // not a language code
    }
    if (name.toLowerCase() === lang.toLowerCase() || name === "root") name = "";
  }
  // Short tags from file names ("sdh", "cc") read better in capitals.
  const extra = title && title.toLowerCase() !== name.toLowerCase() ? (title.length <= 3 ? title.toUpperCase() : title) : "";
  const code = lang && lang.length <= 3 ? lang.toUpperCase() : lang;
  const label = name && extra ? `${name} (${extra})` : name || extra || code || "Unknown language";
  return forced && !/forced/i.test(label) ? `${label}, forced` : label;
}

const isEnglish = (s: any) => /^(en|eng)$/i.test(String(s.tags?.language ?? "")) || /\benglish\b/i.test(String(s.tags?.title ?? ""));
const isCommentary = (s: any) => Boolean(s.disposition?.comment) || /commentary|descri(ptive|bed)|audio description/i.test(String(s.tags?.title ?? ""));

/**
 * The audio track to play: English when the file has it (the main one, not a commentary), else the one the file
 * marks as default, else the first.
 */
export function pickAudio(audios: any[]): any {
  const english = audios.filter(isEnglish);
  const main = english.filter((s) => !isCommentary(s));
  const pool = main.length ? main : english;
  return pool.find((s) => s.disposition?.default) ?? pool[0] ?? audios.find((s) => s.disposition?.default) ?? audios[0];
}

/** Reads codecs and duration from ffprobe's JSON output. */
export function parseProbe(json: any): ProbeResult {
  const streams: any[] = Array.isArray(json?.streams) ? json.streams : [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audios = streams.filter((s) => s.codec_type === "audio");
  const audio = pickAudio(audios);
  const duration = Number(json?.format?.duration ?? video?.duration ?? 0);
  const texts = streams.filter((s) => s.codec_type === "subtitle" && TEXT_SUBTITLES.has(String(s.codec_name)));
  const subtitles = texts.map((s, index) => {
    const lang = typeof s.tags?.language === "string" && s.tags.language !== "und" ? s.tags.language : null;
    const title = typeof s.tags?.title === "string" ? s.tags.title.trim() : "";
    return { index, label: subtitleLabel(lang, title, Boolean(s.disposition?.forced)), lang };
  });
  const audioTracks = audios.map((s, index) => {
    const lang = typeof s.tags?.language === "string" && s.tags.language !== "und" ? s.tags.language : null;
    const title = typeof s.tags?.title === "string" ? s.tags.title.trim() : "";
    const channels = Number(s.channels) || 0;
    const layout = channels === 1 ? "mono" : channels === 2 ? "stereo" : channels === 6 ? "5.1" : channels === 8 ? "7.1" : channels ? `${channels} channels` : "";
    const label = subtitleLabel(lang, title, false);
    return { index, label: layout ? `${label} · ${layout}` : label };
  });
  return {
    container: String(json?.format?.format_name ?? ""),
    duration: Number.isFinite(duration) ? duration : 0,
    video: video ? { codec: String(video.codec_name), width: Number(video.width) || 0, height: Number(video.height) || 0, pixFmt: String(video.pix_fmt ?? "") } : null,
    audio: audio ? { codec: String(audio.codec_name), channels: Number(audio.channels) || 0 } : null,
    videoIndex: video ? Number(video.index) : null,
    audioIndex: audio ? Number(audio.index) : null,
    // Browsers play a file's first audio track and can't switch, so another one needs the converted copy.
    audioNotFirst: !!audio && audio !== audios[0],
    audios: audioTracks,
    audioTrack: audio ? audios.indexOf(audio) : undefined,
    audioIndexes: audios.map((s) => Number(s.index)),
    convert: false,
    subtitles,
    subtitleIndexes: texts.map((s) => Number(s.index)),
  };
}

/** How many segments a file of this length splits into. A sliver at the end joins the last segment. */
export function segmentCount(duration: number, seg = SEGMENT_SECONDS): number {
  return Math.max(1, Math.ceil((duration - 0.5) / seg));
}

/** An HLS playlist listing every segment up front, so players can seek anywhere before it is converted. */
export function playlist(duration: number, seg = SEGMENT_SECONDS): string {
  const count = segmentCount(duration, seg);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${seg + 1}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
  for (let i = 0; i < count; i++) {
    const len = i === count - 1 ? duration - i * seg : seg;
    lines.push(`#EXTINF:${Math.max(0.001, len).toFixed(3)},`, `${i}.ts`);
  }
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

/**
 * ffmpeg arguments that convert a file to H.264 + stereo AAC segments, starting at segment `start`.
 * Seeking with -ss and shifting timestamps back by the same amount keeps segment N at N * seg
 * seconds whichever segment a job starts from, so segments from different jobs fit together.
 */
export function ffmpegArgs(opts: { input: string; probe: ProbeResult; start: number; outDir: string; encoder: string; seg?: number; light?: boolean }): string[] {
  const seg = opts.seg ?? SEGMENT_SECONDS;
  const at = opts.start * seg;
  const nvenc = opts.encoder === "h264_nvenc";
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  // Decode on the GPU when there is one, even when encoding falls back to the CPU; ffmpeg uses the CPU if it can't.
  args.push("-hwaccel", "auto");
  if (at > 0) args.push("-ss", String(at));
  args.push("-i", opts.input);
  if (opts.probe.videoIndex !== null) {
    args.push("-map", `0:${opts.probe.videoIndex}`);
    // Never upscale; 1080p is plenty for streaming to friends. format=yuv420p turns 10-bit into what H.264 players expect.
    args.push("-vf", `scale=-2:min(ih\\,${opts.light ? LIGHT.height : 1080}),format=yuv420p`);
    if (nvenc) args.push("-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-forced-idr", "1");
    else args.push("-c:v", "libx264", "-preset", "superfast", "-crf", "22", "-sc_threshold", "0");
    if (opts.light) args.push("-maxrate", LIGHT.maxrate, "-bufsize", LIGHT.bufsize, "-profile:v", "high");
    else args.push("-maxrate", "10M", "-bufsize", "20M", "-profile:v", "high");
    args.push("-force_key_frames", `expr:gte(t,n_forced*${seg})`);
  }
  if (opts.probe.audioIndex !== null) {
    args.push("-map", `0:${opts.probe.audioIndex}`, "-c:a", "aac", "-b:a", opts.light ? LIGHT.audio : "192k", "-ac", "2");
  }
  args.push("-sn", "-dn", "-max_muxing_queue_size", "4096");
  // The extra 10 s keeps the first frames' timestamps positive. Otherwise the job starting at 0
  // shifts them by the B-frame delay and later jobs don't, leaving a small jump between the two.
  args.push("-output_ts_offset", String(at + 10));
  args.push(
    "-f", "hls",
    "-hls_time", String(seg),
    "-hls_list_size", "0",
    "-hls_segment_type", "mpegts",
    "-hls_flags", "temp_file",
    "-start_number", String(opts.start),
    "-hls_segment_filename", path.join(opts.outDir, "%d.ts"),
    path.join(opts.outDir, "ffmpeg.m3u8"),
  );
  return args;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      return resolve({ code: null, stdout, stderr: "spawn failed" });
    }
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.stdout!.on("data", (d) => (stdout += d));
    proc.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: err.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Runs ffmpeg to pull one subtitle stream out of a file as WebVTT. */
function extractSubtitle(ffmpeg: string, file: string, stream: number): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file, "-map", `0:${stream}`, "-c:s", "webvtt", "-f", "webvtt", "pipe:1"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => proc.kill(), 5 * 60_000);
    proc.stdout!.on("data", (d: Buffer) => chunks.push(d));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
    });
  });
}

/** One JPEG frame from `seconds` into a file, 640 px wide, or null when ffmpeg can't read it there. */
function grabFrame(ffmpeg: string, file: string, seconds: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      // -ss before -i seeks by keyframe, so it's quick even hours in.
      const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", String(Math.max(0, seconds)), "-i", file, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"];
      proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => proc.kill(), 30_000);
    proc.stdout!.on("data", (d: Buffer) => chunks.push(d));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const jpg = Buffer.concat(chunks);
      resolve(code === 0 && jpg.length > 0 ? jpg : null);
    });
  });
}

interface Job {
  proc: ChildProcess;
  start: number;
  /** Highest segment known to be written by this job (start - 1 until the first lands). */
  done: number;
  exited: boolean;
  error: string;
}

interface Session {
  id: string;
  dir: string;
  input: string;
  probe: ProbeResult;
  /** The lighter copy (LIGHT), kept apart from the usual one. */
  light: boolean;
  /** The audio track's stream index, when one other than the file's usual pick was asked for. */
  audioIndex: number | null;
  job: Job | null;
  lastUsed: number;
}

/** Probes files and converts the ones browsers can't play into HLS on demand. */
export class Transcoder {
  private probes = new Map<string, { key: string; result: ProbeResult }>();
  /** Subtitles taken out of files, newest last. Reading one means reading the whole file, so they're kept. */
  private extracted = new Map<string, Promise<string | null>>();
  private sessions = new Map<string, Session>();
  private encoder: Promise<string | null>;
  private encoderUsed: string | null = null;
  private sweeper: NodeJS.Timeout;
  /** Lengths from earlier runs (seconds by path), until this run probes the file itself. */
  private durations: Record<string, number> = {};
  private durationsTimer: NodeJS.Timeout | null = null;

  constructor(private config: TranscodeConfig) {
    if (config.durationsFile) {
      try {
        const saved: unknown = JSON.parse(fs.readFileSync(config.durationsFile, "utf8"));
        if (saved && typeof saved === "object") {
          for (const [file, d] of Object.entries(saved)) if (typeof d === "number" && d > 0) this.durations[file] = d;
        }
      } catch {
        // No file yet, or an unreadable one: lengths come back as files are probed.
      }
    }
    this.encoder = (config.encoder === "off" ? Promise.resolve(null) : this.pickEncoder()).then((e) => (this.encoderUsed = e));
    this.sweeper = setInterval(() => void this.sweep(), 30_000);
    this.sweeper.unref();
  }

  /** The encoder in use, or null when converting is off or ffmpeg is missing. */
  encoderName(): Promise<string | null> {
    return this.encoder;
  }

  private async pickEncoder(): Promise<string | null> {
    const test = (enc: string) =>
      run(this.config.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.2", "-c:v", enc, "-f", "null", "-"], 20_000);
    const wanted = this.config.encoder === "auto" ? ["h264_nvenc", "libx264"] : [this.config.encoder];
    for (const enc of wanted) {
      const r = await test(enc);
      if (r.code === 0) {
        console.log(`transcode: converting with ${enc}`);
        return enc;
      }
      if (r.code === null) break; // ffmpeg itself is missing
      // The first lines carry the cause (e.g. "Driver does not support the required nvenc API version"); the rest is fallout.
      const why = r.stderr.trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(" / ");
      console.warn(`transcode: ${enc} isn't usable${why ? `: ${why}` : ""}`);
    }
    console.warn(`transcode: off (no working ffmpeg at "${this.config.ffmpeg}" with ${wanted.join(" or ")}). Install ffmpeg to play HEVC/AC3 files in browsers.`);
    return null;
  }

  /**
   * A still from the video near `seconds`, for cards with no TMDB art. Right at the start is often a black frame, so a
   * spot there shows a minute in; past the end (a short file), it falls back to the first seconds.
   */
  async frame(file: string, seconds: number): Promise<Buffer | null> {
    const at = seconds >= 10 ? seconds : 60;
    return (await grabFrame(this.config.ffmpeg, file, at)) ?? (at > 5 ? grabFrame(this.config.ffmpeg, file, 5) : null);
  }

  /** Duration from an earlier probe, without touching the disk. Undefined when the file hasn't been probed. */
  cachedDuration(file: string): number | null | undefined {
    const cached = this.probes.get(file);
    return cached ? cached.result.duration || null : undefined;
  }

  /** The length from this run's probe, or else the one kept from an earlier run. */
  knownDuration(file: string): number | null {
    return this.cachedDuration(file) || this.durations[file] || null;
  }

  private keepDuration(file: string, duration: number): void {
    if (!this.config.durationsFile || !(duration > 0) || this.durations[file] === duration) return;
    this.durations[file] = duration;
    if (this.durationsTimer) return;
    this.durationsTimer = setTimeout(() => {
      this.durationsTimer = null;
      const file = this.config.durationsFile!;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.durations));
        fs.renameSync(`${file}.tmp`, file);
      } catch (e) {
        console.warn(`couldn't save ${file}: ${(e as Error).message}`);
      }
    }, 5_000);
    this.durationsTimer.unref();
  }

  /** Codecs and duration, cached until the file changes. Null when ffprobe is missing or fails. */
  async probe(file: string): Promise<ProbeResult | null> {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) return null;
    const key = `${stat.size}:${stat.mtimeMs}`;
    const cached = this.probes.get(file);
    if (cached?.key === key) return cached.result;
    const r = await run(this.config.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], 30_000);
    if (r.code !== 0) return null;
    let result: ProbeResult;
    try {
      result = parseProbe(JSON.parse(r.stdout));
    } catch {
      return null;
    }
    result.convert = (await this.encoder) !== null && result.duration > 0;
    this.probes.set(file, { key, result });
    this.keepDuration(file, result.duration);
    return result;
  }

  /**
   * Subtitle track `n` from inside the file as WebVTT, or null when there isn't one or ffmpeg fails.
   * ffmpeg reads the whole file to collect it, so the result is cached until the file changes.
   */
  async subtitle(file: string, n: number): Promise<string | null> {
    const probe = await this.probe(file);
    const stream = probe?.subtitleIndexes[n];
    if (stream === undefined) return null;
    const cached = this.probes.get(file)!.key;
    const key = `${file}|${cached}|${stream}`;
    let result = this.extracted.get(key);
    if (!result) {
      result = extractSubtitle(this.config.ffmpeg, file, stream);
      this.extracted.set(key, result);
      if (this.extracted.size > 40) this.extracted.delete(this.extracted.keys().next().value!);
      result.then((text) => text === null && this.extracted.delete(key));
    } else {
      // Keep recently used ones.
      this.extracted.delete(key);
      this.extracted.set(key, result);
    }
    return result;
  }

  /**
   * The conversion of one file: the usual copy, or the lighter one ([light]), with the audio track the file plays or
   * audio track [audio] (counting audio tracks only). Each is kept apart, since they're different videos.
   */
  private async session(item: string, input: string, light: boolean, audio?: number): Promise<Session | null> {
    const probe = await this.probe(input);
    if (!probe?.convert) return null;
    const stream = audio !== undefined && audio !== probe.audioTrack ? probe.audioIndexes[audio] : undefined;
    if (audio !== undefined && audio !== probe.audioTrack && stream === undefined) return null;
    const id = `${item}${light ? "-light" : ""}${stream !== undefined ? `-a${audio}` : ""}`;
    let s = this.sessions.get(id);
    if (s && s.input === input) {
      s.lastUsed = Date.now();
      return s;
    }
    if (s) await this.drop(id);
    s = this.sessions.get(id); // another request may have created it meanwhile
    if (s && s.input === input) return s;
    const dir = path.join(this.config.dir, id);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    s = { id, dir, input, probe, light, audioIndex: stream ?? null, job: null, lastUsed: Date.now() };
    this.sessions.set(id, s);
    return s;
  }

  /** [light]: the lighter copy for slow connections (LIGHT) instead of the usual one; [audio]: another audio track. */
  async playlist(id: string, input: string, light = false, audio?: number): Promise<string | null> {
    const s = await this.session(id, input, light, audio);
    return s && playlist(s.probe.duration);
  }

  /** Path of segment n once it exists, converting from there if no running job will reach it soon. */
  async segment(id: string, input: string, n: number, light = false, audio?: number): Promise<string | null> {
    const s = await this.session(id, input, light, audio);
    if (!s || n < 0 || n >= segmentCount(s.probe.duration)) return null;
    const file = path.join(s.dir, `${n}.ts`);
    const deadline = Date.now() + SEGMENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      s.lastUsed = Date.now();
      if (fs.existsSync(file)) return file;
      if (this.sessions.get(s.id) !== s) return null;
      const job = s.job;
      if (job) this.advance(s, job);
      const coming = job && !job.exited && n >= job.start && n <= job.done + AHEAD_WINDOW;
      if (!coming) {
        // A job that started right here and stopped without writing it means it can't be made.
        if (job?.exited && job.start === n) {
          if (job.error) throw new Error(job.error.trim());
          return null;
        }
        this.startJob(s, n);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  }

  /** Moves job.done past every segment the job has finished. */
  private advance(s: Session, job: Job): void {
    while (fs.existsSync(path.join(s.dir, `${job.done + 1}.ts`))) job.done++;
  }

  private startJob(s: Session, start: number): void {
    // SIGKILL: on a gentle stop ffmpeg finishes the segment it is on, leaving a short one behind.
    s.job?.proc.kill("SIGKILL");
    const probe = s.audioIndex !== null ? { ...s.probe, audioIndex: s.audioIndex } : s.probe;
    const args = ffmpegArgs({ input: s.input, probe, start, outDir: s.dir, encoder: this.encoderUsed ?? "libx264", light: s.light });
    const proc = spawn(this.config.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const job: Job = { proc, start, done: start - 1, exited: false, error: "" };
    // Not "Failed setup for format dxva2_vld: hwaccel initialisation returned error": the GPU couldn't decode this file,
    // so ffmpeg carries on with the CPU.
    proc.stderr!.on("data", (d) => (job.error = (job.error + String(d).split("\n").filter((l) => !/hwaccel initiali[sz]ation returned error/.test(l)).join("\n")).slice(-2000)));
    proc.on("error", (err) => {
      job.exited = true;
      job.error = err.message;
    });
    proc.on("close", (code) => {
      job.exited = true;
      // No code: stopped on purpose (a jump elsewhere started a new job, or nobody's watching), not a failure.
      if (code === 0 || code === null) job.error = "";
      else if (job.error.trim()) console.warn(`transcode: ffmpeg stopped (${code}): ${job.error.trim().split("\n").pop()}`);
    });
    s.job = job;
  }

  private async drop(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.job?.proc.kill("SIGKILL");
    // On Windows the killed ffmpeg can hold its files open for a moment.
    await new Promise((r) => setTimeout(r, 200));
    await fsp.rm(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, s] of [...this.sessions]) if (now - s.lastUsed > IDLE_MS) await this.drop(id);
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.keys()].map((id) => this.drop(id)));
  }
}
