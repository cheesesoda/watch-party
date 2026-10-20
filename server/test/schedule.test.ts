import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LATE_MS, OPENS_EARLY_MS, Schedule } from "../src/schedule.ts";

test("scheduled parties survive a restart, open 30 minutes early, and are dropped when missed by hours", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-sched-"));
  const file = path.join(dir, "schedule.json");
  let now = 1_000_000_000;
  const a = new Schedule(file, () => now);
  a.add("aaaaaa", ["m1", "m2"], now + 3600_000, "Jake");
  a.add("bbbbbb", ["m3"], now + 2 * 3600_000, null);
  const b = new Schedule(file, () => now);
  assert.deepEqual(b.list().map((p) => p.id), ["aaaaaa", "bbbbbb"]);
  assert.equal(b.get("AAAAAA")?.host, "Jake");
  assert.deepEqual(b.takeDue(), []);
  now += 3600_000 - OPENS_EARLY_MS;
  assert.deepEqual(b.takeDue().map((p) => p.id), ["aaaaaa"]);
  assert.equal(new Schedule(file, () => now).has("aaaaaa"), false);
  // The PC was off all evening: a party long past its time is dropped, not opened.
  now += 2 * 3600_000 + LATE_MS;
  assert.deepEqual(b.takeDue(), []);
  assert.deepEqual(b.list(), []);
  assert.equal(b.remove("bbbbbb"), false);
  await fs.rm(dir, { recursive: true, force: true });
});
