import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readWav } from "../src/clips";
import { RingDetector, SAMPLE_RATE } from "../src/ring";

/**
 * Replays real recordings through the detector. The recordings are private and
 * never committed, so they live outside the repository:
 *
 *   $RING_SAMPLES_DIR/ring/*.wav       each must fire exactly once
 *   $RING_SAMPLES_DIR/not-ring/*.wav   none may fire
 *
 * Files are 16 kHz 16-bit mono wav, which is what the listener saves. To turn a
 * misfire or a miss into a permanent test, copy its clip into the right folder.
 * Without the folder these tests are skipped.
 */
const dir = process.env["RING_SAMPLES_DIR"] ?? path.join(os.homedir(), "doorbell-recordings", "cases");

const list = (kind: string) => {
  const d = path.join(dir, kind);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".wav")).sort() : [];
};

function fires(file: string) {
  const { pcm, sampleRate } = readWav(file);
  if (sampleRate !== SAMPLE_RATE) throw new Error(`${file}: ${sampleRate} Hz, expected ${SAMPLE_RATE}`);
  return new RingDetector().push(pcm).filter((e) => e.type === "ring");
}

const rings = list("ring");
const others = list("not-ring");

test.skipIf(!rings.length)(`recorded rings fire once each (${rings.length} files)`, () => {
  const wrong = rings.filter((f) => fires(path.join(dir, "ring", f)).length !== 1);
  expect(wrong).toEqual([]);
});

test.skipIf(!others.length)(`recorded other sounds do not fire (${others.length} files)`, () => {
  const wrong = others.filter((f) => fires(path.join(dir, "not-ring", f)).length !== 0);
  expect(wrong).toEqual([]);
});
