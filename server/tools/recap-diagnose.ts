// Why a recap goes unfound: lists every stretch an episode's opening shares with each earlier episode, whether the
// offset is among the 60 likeliest that findRecap looks at, and what findRecap makes of them.
// node --import tsx tools/recap-diagnose.ts <ffmpeg> <episode> <earlier episode>...
import { spawnSync } from "node:child_process";
import { findRecap, sharedStretches } from "../src/markers.ts";

const [ffmpeg, target, ...earlier] = process.argv.slice(2);
const STEP = 0.1238; // seconds per chromaprint point
const fp = (file: string, start = 0, length?: number) => {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", String(start), "-i", file, ...(length ? ["-t", String(length)] : []), "-vn", "-sn", "-dn", "-ac", "1", "-f", "chromaprint", "-fp_format", "raw", "pipe:1"];
  const r = spawnSync(ffmpeg, args, { maxBuffer: 1 << 28, timeout: 20 * 60_000 });
  if (r.status !== 0) throw new Error(`${file}: ${r.stderr}`);
  const out = new Uint32Array(r.stdout.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = r.stdout.readUInt32LE(i * 4);
  return out;
};
const bits = (n: number) => { n -= (n >>> 1) & 0x55555555; n = (n & 0x33333333) + ((n >>> 2) & 0x33333333); return (((n + (n >>> 4)) & 0xf0f0f0f) * 0x1010101) >>> 24; };
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

const head = fp(target, 0, 240);
const counts = new Map<number, number>();
head.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1));
console.log(`${target}: ${head.length} points in 240 s, ${counts.size} distinct, most repeated ${Math.max(...counts.values())}x`);
const all: { start: number; end: number }[] = [];
for (const file of earlier) {
  const src = fp(file);
  const where = new Map<number, number[]>();
  src.forEach((v, j) => { const l = where.get(v); if (l) l.push(j); else where.set(v, [j]); });
  const votes = new Map<number, number>();
  head.forEach((v, i) => { for (const j of where.get(v) ?? []) votes.set(i - j, (votes.get(i - j) ?? 0) + 1); });
  const ranked = [...votes.entries()].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]);
  const rank = new Map(ranked.map(([o], k) => [o, k]));
  console.log(`\n${file}: ${src.length} points (${clock(src.length * STEP)}), ${ranked.length} offsets with 2+ votes, 60th has ${ranked[59]?.[1]} votes`);
  // Every offset, every run of >= 1.5 s where points differ by <= 6 bits, gaps <= 1 s: the 40 longest, in order.
  const lines: { at: number; len: number; text: string }[] = [];
  for (const [offset] of ranked) {
    let start = -1, last = -1, hits = 0;
    const close = () => {
      const len = (last - start + 1) * STEP;
      if (start >= 0 && len >= 1.5 && hits * 2 >= last - start + 1 && start * STEP < 150) {
        const r = rank.get(offset)!;
        lines.push({ at: start, len, text: `  opening ${clock(start * STEP)}-${clock((last + 1) * STEP)} (${len.toFixed(1)} s) = ${clock((start - offset) * STEP)} in this one; offset rank ${r}${r < 60 ? "" : " (NOT looked at)"}, votes ${votes.get(offset)}, ${hits} close points${len < 2.5 ? ", under 2.5 s" : ""}` });
      }
    };
    for (let i = Math.max(0, offset); i < Math.min(head.length, src.length + offset); i++) {
      if (bits(head[i] ^ src[i - offset]) > 6) continue;
      if (start < 0 || i - last > 8) { close(); start = i; hits = 0; }
      last = i; hits++;
    }
    close();
  }
  for (const l of lines.sort((x, y) => y.len - x.len).slice(0, 40).sort((x, y) => x.at - y.at)) console.log(l.text);
  for (const h of sharedStretches(head, src, 2.5)) if (h.a.start < 150) all.push(h.a);
  const one = findRecap(head, [], [{ points: src, from: 0, ignore: () => false }]);
  console.log(`  findRecap against this one alone (nothing ignored): ${one ? `${clock(one.start)}-${clock(one.end)}` : "none"}`);
}
console.log(`\nfindRecap's own clips (2.5 s+, top 60 offsets) in the first 150 s: ${all.sort((a, b) => a.start - b.start).map((a) => `${clock(a.start)}-${clock(a.end)}`).join(", ") || "none"}`);
