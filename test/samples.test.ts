import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readWav } from "../src/clips";
import { RingMatcher, SAMPLE_RATE } from "../src/matcher";

/**
 * Replays real recordings through the matcher. The recordings are private and
 * never committed, so they live outside the repository:
 *
 *   $RING_SAMPLES_DIR/ring/*.wav       each must fire exactly once
 *   $RING_SAMPLES_DIR/not-ring/*.wav   none may fire
 *
 * Files are 16 kHz 16-bit mono wav, which is what the listener saves. To turn a
 * misfire or a miss into a permanent test, copy its clip into the right folder.
 * Without the folder these tests are skipped.
 *
 * Files in ring/ with "other-room" in the name are stress tests: the recorded ring
 * played back from a laptop in other rooms with a lot of noise. They must never fire
 * twice, and at least half of them must fire; the test prints which ones did not.
 */
const dir = process.env["RING_SAMPLES_DIR"] ?? path.join(os.homedir(), "doorbell-recordings", "cases");

const list = (kind: string) => {
  const d = path.join(dir, kind);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".wav")).sort() : [];
};

function fires(file: string) {
  const { pcm, sampleRate } = readWav(file);
  if (sampleRate !== SAMPLE_RATE) throw new Error(`${file}: ${sampleRate} Hz, expected ${SAMPLE_RATE}`);
  return new RingMatcher().push(pcm).filter((e) => e.type === "ring");
}

const all = list("ring");
const rings = all.filter((f) => !f.includes("other-room"));
const stress = all.filter((f) => f.includes("other-room"));
const others = list("not-ring");

test.skipIf(!rings.length)(`recorded rings fire once each (${rings.length} files)`, () => {
  const wrong = rings.filter((f) => fires(path.join(dir, "ring", f)).length !== 1);
  expect(wrong).toEqual([]);
});

test.skipIf(!stress.length)(`stress playbacks never fire twice, and most fire (${stress.length} files)`, () => {
  const counts = stress.map((f) => fires(path.join(dir, "ring", f)).length);
  const missed = stress.filter((_, i) => counts[i] === 0);
  if (missed.length) console.log(`stress playbacks not caught: ${missed.join(", ")}`);
  expect(Math.max(...counts)).toBeLessThanOrEqual(1);
  expect(missed.length).toBeLessThanOrEqual(stress.length / 2);
});

test.skipIf(!others.length)(`recorded other sounds do not fire (${others.length} files)`, () => {
  const wrong = others.filter((f) => fires(path.join(dir, "not-ring", f)).length !== 0);
  expect(wrong).toEqual([]);
});
