import assert from "node:assert/strict";
import { test } from "node:test";
import { findSubtitleRecap, normalize, parseCues } from "../src/subtitleRecaps.ts";
import { englishTrack } from "../src/subtitles.ts";

/** SubRip text from [start, end, text] cues. */
const srt = (cues: [number, number, string][]) =>
  cues
    .map(([s, e, t], i) => {
      const at = (x: number) => `00:${String(Math.floor(x / 60)).padStart(2, "0")}:${String(Math.floor(x % 60)).padStart(2, "0")},${String(Math.round((x % 1) * 1000)).padStart(3, "0")}`;
      return `${i + 1}\n${at(s)} --> ${at(e)}\n${t}`;
    })
    .join("\n\n");

const episode1 = parseCues(
  srt([
    [62, 65, "I'm not a cop anymore."],
    [70, 74, "Somebody killed my brother,\nand I'm going to find out who."],
    [300, 304, "The money went through\nthe warehouse in Margrave."],
    [900, 903, "You can't arrest him.\nHe owns this town."],
    [1500, 1502, "Yeah."],
  ]),
);
const episode2 = parseCues(
  srt([
    [40, 44, "Finlay, you need to see this."],
    [400, 404, "Kliner's been paying everyone off."],
  ]),
);

test("subtitle text is compared by what's said: no tags, sound notes, speaker names or punctuation", () => {
  assert.equal(normalize("<i>NARRATOR: Previously on</i> Reacher..."), "previously on reacher");
  assert.equal(normalize("- [door slams]\n- You can't arrest him!"), "you cant arrest him");
  assert.equal(normalize("♪ ♪"), "");
});

test("a recap runs from its Previously on line to the last line said in earlier episodes", () => {
  const cues = parseCues(
    srt([
      [2, 4, "WARNING: This episode contains violence."],
      [6, 8, "<i>Previously on Reacher...</i>"],
      [9, 12, "Somebody killed my brother,"],
      [12, 14, "and I'm going to find out who."],
      [16, 19, "You can't arrest him."],
      [21, 25, "Kliner's been paying everyone off."],
      [27, 28, "Go."],
      // The episode itself: new lines from here.
      [70, 73, "Where were you last night?"],
      [74, 77, "Nobody in this town talks to me."],
    ]),
  );
  const recap = findSubtitleRecap(cues, [episode1, episode2]);
  assert.deepEqual(recap, { range: { start: 6, end: 25 }, matched: 4 });
});

test("a recap line that runs two speakers together, or trims a line, still counts", () => {
  const before = parseCues(
    srt([
      [100, 102, "Azhari Mahmoud."],
      [103, 106, "Yeah, we've been calling him A.M."],
      [400, 404, "We call that a win-win, someone in engineering told me."],
      [800, 803, "Hands up, all of you, right now."],
    ]),
  );
  const cues = parseCues(
    srt([
      [0, 2, "Previously on Reacher"],
      [3, 6, "Azhari Mahmoud.\nYeah, we've been calling him A.M."],
      [8, 11, "- We call that a win-win.\n- Someone in engineering told me."],
      [13, 15, "Something nobody said before here."],
      [16, 19, "Hands up, all of you."],
      // The episode: 12 s of new lines ends it.
      [22, 25, "Where were you all night long?"],
      [27, 30, "Nobody in this town talks to me."],
      [32, 35, "I don't know what you're talking about."],
      [36, 39, "Hands up, all of you, right now."],
    ]),
  );
  assert.deepEqual(findSubtitleRecap(cues, [before])?.range, { start: 0, end: 19 });
});

test("no Previously on line, or one with nothing said before after it, is no recap", () => {
  const cold = parseCues(srt([[5, 8, "Somebody killed my brother,"], [9, 12, "and I'm going to find out who."], [14, 17, "You can't arrest him."]]));
  assert.equal(findSubtitleRecap(cold, [episode1]), null);
  // "Previously" said in the story, followed by new lines.
  const said = parseCues(srt([[30, 33, "Previously, he worked for the army."], [34, 38, "That's what the file says about him."], [40, 44, "Then where did he go after that?"]]));
  assert.equal(findSubtitleRecap(said, [episode1, episode2]), null);
  // Too far in to be a recap.
  const late = parseCues(srt([[400, 402, "Previously on Reacher"], [403, 406, "Somebody killed my brother,"], [407, 410, "You can't arrest him."]]));
  assert.equal(findSubtitleRecap(late, [episode1]), null);
});

test("a recap ends after 12 s of new lines or a long silence, not at one new line between clips", () => {
  const cues = parseCues(
    srt([
      [0, 2, "Previously on Reacher"],
      [3, 6, "Somebody killed my brother,"],
      // A line the earlier subtitles wrote differently.
      [7, 9, "Hey, wait a second there."],
      [10, 13, "The money went through the warehouse in Margrave."],
      // Silence, then the episode.
      [60, 63, "You can't arrest him."],
    ]),
  );
  assert.deepEqual(findSubtitleRecap(cues, [episode1])?.range, { start: 0, end: 13 });
});

test("the English track is one tagged English, else one with no language, never a forced one", () => {
  assert.equal(englishTrack([{ lang: "fre", label: "French" }, { lang: "eng", label: "English, forced" }, { lang: "eng", label: "English (SDH)" }]), 2);
  assert.equal(englishTrack([{ lang: null, label: "Default" }, { lang: "en", label: "English" }]), 1);
  assert.equal(englishTrack([{ lang: null, label: "Default" }]), 0);
  assert.equal(englishTrack([{ lang: "spa", label: "Spanish" }]), -1);
});
