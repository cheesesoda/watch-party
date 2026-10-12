import type { MediaInfo } from "../../shared/protocol.ts";

// Codec strings browsers understand, for the codecs ffprobe reports. Anything missing here
// (DTS, TrueHD, MPEG-4 Part 2, ...) no browser plays.
const VIDEO: Record<string, string> = {
  h264: 'video/mp4; codecs="avc1.640028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L150.90"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  vp9: 'video/webm; codecs="vp9"',
  vp8: 'video/webm; codecs="vp8"',
};
const VIDEO_10BIT: Record<string, string> = {
  h264: 'video/mp4; codecs="avc1.6e0028"',
  hevc: 'video/mp4; codecs="hvc1.2.4.L150.90"',
  av1: 'video/mp4; codecs="av01.0.08M.10"',
  vp9: 'video/webm; codecs="vp09.02.40.10"',
};
const AUDIO: Record<string, string> = {
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: "audio/mpeg",
  opus: 'audio/webm; codecs="opus"',
  vorbis: 'audio/webm; codecs="vorbis"',
  flac: 'audio/mp4; codecs="flac"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
};
// Containers browsers open. Matroska only works in some (Chrome does), so playback falls back if it fails.
const CONTAINERS = ["mp4", "mov", "webm", "matroska"];

function supported(type: string | undefined): boolean {
  if (!type) return false;
  if (globalThis.MediaSource?.isTypeSupported?.(type)) return true;
  return document.createElement("video").canPlayType(type) === "probably";
}

/** Whether this browser should be able to play the file as-is, judging by its codecs. */
export function canPlayDirect(info: MediaInfo): boolean {
  if (!CONTAINERS.some((c) => info.container.split(",").includes(c))) return false;
  if (info.video) {
    const tenBit = /10|12/.test(info.video.pixFmt);
    if (!supported((tenBit ? VIDEO_10BIT : VIDEO)[info.video.codec])) return false;
  }
  if (info.audio && !supported(AUDIO[info.audio.codec])) return false;
  return true;
}

/** Whether hls.js can run here. iPhones lack MediaSource but play HLS natively. */
export function hasMse(): boolean {
  return "MediaSource" in globalThis || "ManagedMediaSource" in globalThis;
}
