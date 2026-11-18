import { expect, test } from "bun:test";

import { RingDetector, SAMPLE_RATE as SR, type RingEvent } from "../src/ring";

// Deterministic noise so the tests do not flake.
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

/** Measured levels of the ring's first ten multiples, in dB. */
const LEVELS = [-8, -2, -7, -9, -11, 0, -16, -19, -26, -18];

/** Silence, then a synthetic intercom ring starting at `at` seconds: a short burst, then six pulses. */
function ringAudio({ at = 2, total = 8, f0 = 391, gain = 0.05, noise = 0.002, levels = LEVELS } = {}) {
  const x = new Float32Array(total * SR);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR - at;
    let on = false;
    if (t >= 0 && t < 0.15) on = true;
    else if (t >= 0.25 && t < 3.3) on = (t - 0.25) % 0.52 < 0.44;
    let v = 0;
    if (on) levels.forEach((db, k) => (v += 10 ** (db / 20) * Math.sin(2 * Math.PI * f0 * (k + 1) * (i / SR))));
    x[i] = gain * v + noise * rand();
  }
  return x;
}

function note(f: number, seconds = 10, partials = 17) {
  const x = new Float32Array(seconds * SR);
  for (let i = 0; i < x.length; i++) {
    let v = 0;
    for (let k = 1; k <= partials && f * k < 7500; k++) v += Math.sin(2 * Math.PI * f * k * (i / SR)) / k;
    x[i] = 0.05 * v + 0.002 * rand();
  }
  return x;
}

function run(x: Float32Array, cfg = {}) {
  const d = new RingDetector({ ...new RingDetector().cfg, ...cfg });
  const events: RingEvent[] = [];
  // feed in uneven chunks, as a pipe would
  for (let i = 0; i < x.length; ) {
    const n = 1000 + ((i * 7) % 3000);
    events.push(...d.push(x.subarray(i, i + n)));
    i += n;
  }
  return events.filter((e) => e.type === "ring");
}

test("a ring fires once, within a second of starting", () => {
  const rings = run(ringAudio());
  expect(rings.length).toBe(1);
  expect(rings[0]!.t - 2).toBeGreaterThan(0.3);
  expect(rings[0]!.t - 2).toBeLessThan(1.0);
  expect(rings[0]).toMatchObject({ path: "fast" });
});

test("loudness does not matter", () => {
  for (const gain of [0.0005, 0.005, 0.5]) {
    expect(run(ringAudio({ gain, noise: gain / 25 })).length).toBe(1);
  }
});

test("a different microphone position (other balance between the multiples) still fires", () => {
  const tilted = LEVELS.map((db, k) => db + (k < 3 ? -15 : 6));
  expect(run(ringAudio({ levels: tilted })).length).toBe(1);
  const reversed = [...LEVELS].reverse();
  expect(run(ringAudio({ levels: reversed })).length).toBe(1);
});

test("fires with broadband noise as loud as the ring", () => {
  // ring rms is about 0.05 * 1.1 / sqrt(2); uniform noise of amplitude a has rms a / sqrt(3)
  expect(run(ringAudio({ noise: 0.065 })).length).toBe(1);
});

test("a ring a little off pitch still fires, one far off does not", () => {
  expect(run(ringAudio({ f0: 392 })).length).toBe(1);
  expect(run(ringAudio({ f0: 389.5 })).length).toBe(1);
  expect(run(ringAudio({ f0: 370 })).length).toBe(0);
  expect(run(ringAudio({ f0: 415 })).length).toBe(0);
});

test("noise, single tones and other notes do not fire", () => {
  const noise = new Float32Array(10 * SR).map(() => 0.3 * rand());
  expect(run(noise).length).toBe(0);
  for (const f of [780, 1170, 1950, 2740, 3880]) {
    const tone = new Float32Array(10 * SR).map((_, i) => 0.05 * Math.sin((2 * Math.PI * f * i) / SR) + 0.002 * rand());
    expect(run(tone).length).toBe(0);
  }
  // notes whose partials land on the ring's pitches but also in between
  for (const f of [195.5, 130.33, 440, 329.6]) expect(run(note(f)).length).toBe(0);
});

test("a short note at the ring's pitch does not fire", () => {
  const x = new Float32Array(10 * SR).map(() => 0.002 * rand());
  x.set(note(391, 1.2), 2 * SR);
  expect(run(x).length).toBe(0);
});

test("the cooldown stops a second fire during the same ring", () => {
  const x = new Float32Array(20 * SR);
  x.set(ringAudio({ total: 8 }), 0);
  x.set(ringAudio({ total: 8 }), 8 * SR);
  expect(run(x).length).toBe(1);
  expect(run(x, { cooldownS: 5 }).length).toBe(2);
});
