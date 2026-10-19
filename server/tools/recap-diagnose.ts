// Why a recap goes unfound: lists every stretch of 1.5 s or more an episode's opening shares with each earlier
// episode, lined up the way findRecap lines them up (RECAP_OFFSETS), and what findRecap makes of each one alone.
// Fingerprints are kept in [cache] (a folder), so running it again is quick.
// node --import tsx tools/recap-diagnose.ts <ffmpeg> <cache> <episode> <earlier episode>...
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findRecap, RECAP_OFFSETS, sharedStretches } from "../src/markers.ts";

const [ffmpeg, cache, target, ...earlier] = process.argv.slice(2);
fs.mkdirSync(cache, { recursive: true });
const fp = (file: string, length?: number) => {
  const saved = path.join(cache, `${createHash("sha1").update(`${file}|${length ?? "all"}`).digest("hex")}.fp`);
  if (fs.existsSync(saved)) return new Uint32Array(new Uint8Array(fs.readFileSync(saved)).buffer);
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file, ...(length ? ["-t", String(length)] : []), "-vn", "-sn", "-dn", "-ac", "1", "-f", "chromaprint", "-fp_format", "raw", "pipe:1"];
  const r = spawnSync(ffmpeg, args, { maxBuffer: 1 << 28, timeout: 20 * 60_000 });
  if (r.status !== 0) throw new Error(`${file}: ${r.stderr}`);
  const out = new Uint32Array(r.stdout.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = r.stdout.readUInt32LE(i * 4);
  fs.writeFileSync(saved, Buffer.from(out.buffer));
  return out;
};
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

const head = fp(target, 240);
console.log(`${target}: ${head.length} points in the first 240 s`);
for (const file of earlier) {
  const src = fp(file);
  console.log(`\n${path.basename(file)} (${clock(src.length * 0.1238)})`);
  const exact = sharedStretches(head, src, 1.5, { ...RECAP_OFFSETS, near: 0 }).filter((h) => h.a.start < 150).length;
  const hits = sharedStretches(head, src, 1.5, RECAP_OFFSETS).filter((h) => h.a.start < 150).sort((x, y) => x.a.start - y.a.start);
  for (const h of hits) console.log(`  opening ${clock(h.a.start)}-${clock(h.a.end)} (${(h.a.end - h.a.start).toFixed(1)} s) = ${clock(h.b.start)} in this one${h.a.end - h.a.start < 2.5 ? ", under 2.5 s" : ""}`);
  console.log(`  ${hits.length} stretches lined up on near points (${exact} on exact points only)`);
  const one = findRecap(head, [], [{ points: src, from: 0, ignore: () => false }]);
  console.log(`  findRecap against this one alone (nothing ignored): ${one ? `${clock(one.start)}-${clock(one.end)}` : "none"}`);
}
