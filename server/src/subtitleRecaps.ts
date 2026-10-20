import type { TimeRange } from "../../shared/protocol.ts";

/**
 * Recaps found by their subtitles: a "Previously on…" line near the start, then the lines that follow it that were
 * already said in earlier episodes. Works where sound can't (Reacher remixes its recap clips under narration and new
 * music), since the words stay the same.
 */

export interface Cue {
  start: number;
  end: number;
  /** Lower case, without tags, speaker names or punctuation: what's said, for comparing. */
  text: string;
}

/** "Previously on Reacher", "Last time on…", "Previously…": the line a recap opens with. */
const OPENER = /^(previously\b|last (time|week|season) on\b)|\bpreviously on\b/;
/** The opener is looked for this far in (s): after a cold open, a warning card or a studio logo, but not later. */
export const OPENER_WINDOW = 300;
/** Lines shorter than this ("Yeah.", "Go.") prove nothing either way: they'd match anywhere. */
const MIN_CHARS = 12;
/** A recap ends after this long (s) of lines that weren't said before, or a silence this long (s). */
const MAX_UNMATCHED = 12;
const MAX_SILENCE = 20;
/**
 * A line counts as said before when at least this share of its 4-word runs were: a recap trims lines, and puts two
 * speakers' lines in one subtitle that the earlier episode showed apart. Lines under 4 words must be found whole.
 */
const PHRASE = 4;
const MIN_SHARE = 0.5;
/** At least this many of its lines were said before, so a "previously" in the dialogue isn't taken for a recap. */
const MIN_MATCHED = 2;
/** Recaps shorter than this (s) get no button (as SKIP_MIN for marks). */
const MIN_LENGTH = 10;

/** "00:01:02.500" or "01:02,500" (SubRip) in seconds. */
function seconds(t: string): number {
  const parts = t.trim().replace(",", ".").split(":").map(Number);
  return parts.reduce((sum, p) => sum * 60 + p, 0);
}

/** What a line says, for comparing: no tags, [sound] or (notes), speaker names, music signs, punctuation or case. */
export function normalize(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/^[ \t]*-?[ \t]*[A-Z][A-Z0-9 .'-]{1,30}:/gm, " ")
    .replace(/[♪♫#]/g, " ")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The cues of a WebVTT or SubRip file, in order. */
export function parseCues(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const m = lines[at].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!m) continue;
    // Two speakers in one subtitle ("- Who's he? / - Beats me.") are two lines, each said on its own before.
    const speakers: string[][] = [];
    for (const line of lines.slice(at + 1)) {
      if (speakers.length === 0 || /^(<[^>]*>|\{[^}]*\}|\s)*-/.test(line)) speakers.push([]);
      speakers[speakers.length - 1].push(line);
    }
    for (const part of speakers) {
      const said = normalize(part.join("\n"));
      if (said) cues.push({ start: seconds(m[1]), end: seconds(m[2]), text: said });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

export interface SubtitleRecap {
  range: TimeRange;
  /** How many of its lines were said in earlier episodes. */
  matched: number;
}

/**
 * The recap in an episode's subtitles, or null: from its "Previously on…" line through the last line after it that
 * [earlier] episodes (their cues, as parseCues gives them) already said. Lines are compared by what's said, in 4-word
 * runs, so a line a recap cuts short or runs into another still counts.
 */
export function findSubtitleRecap(cues: Cue[], earlier: Cue[][]): SubtitleRecap | null {
  const opener = cues.findIndex((c) => c.start < OPENER_WINDOW && OPENER.test(c.text));
  if (opener < 0) return null;
  // Every earlier line one after another, so a recap line split over two cues there (or two run into one here) is found.
  const episodes = earlier.map((list) => list.map((c) => c.text).join(" "));
  const before = ` ${episodes.join(" | ")} `;
  const phrases = new Set<string>();
  for (const words of episodes.map((e) => e.split(" "))) {
    for (let i = 0; i + PHRASE <= words.length; i++) phrases.add(words.slice(i, i + PHRASE).join(" "));
  }
  const said = (text: string) => {
    const words = text.split(" ");
    if (words.length < PHRASE) return before.includes(` ${text} `);
    let found = 0;
    for (let i = 0; i + PHRASE <= words.length; i++) if (phrases.has(words.slice(i, i + PHRASE).join(" "))) found++;
    return found / (words.length - PHRASE + 1) >= MIN_SHARE;
  };
  let last: Cue | null = null;
  let matched = 0;
  let prevEnd = cues[opener].end;
  let lastSaid = cues[opener].end;
  for (let i = opener + 1; i < cues.length; i++) {
    const c = cues[i];
    if (c.start - prevEnd > MAX_SILENCE) break;
    prevEnd = c.end;
    // The opener's own words ("previously on reacher") run on into the next cue sometimes.
    if (c.text.length < MIN_CHARS) continue;
    if (said(c.text)) {
      last = c;
      matched++;
      lastSaid = c.end;
    } else if (c.start - lastSaid > MAX_UNMATCHED) break;
  }
  if (!last || matched < MIN_MATCHED) return null;
  const range = { start: round(cues[opener].start), end: round(last.end) };
  return range.end - range.start >= MIN_LENGTH ? { range, matched } : null;
}

function round(t: number): number {
  return Math.round(t * 10) / 10;
}
