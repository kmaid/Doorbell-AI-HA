import { expect, test } from "bun:test";

import { RingMatcher, defaultMatcherConfig, type MatcherEvent } from "../src/matcher";
import { MULTIPLES, SR, note, noiseSource, ring, scene, sequence } from "./synthetic-ring";

// All audio here is synthetic. The ring is built from the measured description of the
// real one and scores about 0.7 where a real ring scores about 0.9, so these tests are
// harder on the matcher than the real thing is.

function events(x: Float32Array, cfg = {}) {
  const d = new RingMatcher({ ...defaultMatcherConfig, ...cfg });
  const out: MatcherEvent[] = [];
  // feed in uneven chunks, as a pipe would
  for (let i = 0; i < x.length; ) {
    const n = 1000 + ((i * 7) % 3000);
    out.push(...d.push(x.subarray(i, i + n)));
    i += n;
  }
  return out;
}
const fires = (x: Float32Array, cfg = {}) => events(x, cfg).filter((e) => e.type === "ring");

/** Seconds from the start of a ring placed 2 s into 8 s of hiss to the matcher firing, or -1. */
function delay(r: Float32Array, hiss?: number, seed = 1) {
  const f = fires(scene(8, [[2, r]], hiss, seed));
  expect(f.length).toBeLessThanOrEqual(1);
  return f.length ? f[0]!.t - 2 : -1;
}

const G4 = 390.625, Bb4 = 468.75, G5 = 781.25;
const chord = (fs: number[], seconds: number) => {
  const out = note(fs[0]!, seconds);
  for (const f of fs.slice(1)) note(f, seconds).forEach((v, i) => (out[i]! += v));
  return out;
};

test("a ring fires once, soon after its first full cycle", () => {
  const d = delay(ring());
  expect(d).toBeGreaterThan(0.3);
  expect(d).toBeLessThan(1.5);
});

test("it does not matter where in the cycle the ring picks up", () => {
  for (const startPhase of [0.1, 0.25, 0.4, 0.5, 0.65, 0.75, 0.9]) {
    const d = delay(ring({ startPhase }));
    expect(d).toBeGreaterThan(0.3);
    expect(d).toBeLessThan(1.5);
  }
});

test("a short press of 0.6 s fires, and a long one fires only once", () => {
  expect(delay(ring({ seconds: 0.6 }))).toBeGreaterThan(0);
  expect(fires(scene(20, [[2, ring({ seconds: 12 })]])).length).toBe(1);
});

test("loudness does not matter", () => {
  for (const gain of [0.01, 1, 10]) {
    expect(delay(ring({ level: 0.03 * gain }), 0.005 * gain)).toBeGreaterThan(0);
  }
});

test("a different microphone position (other balance between the partials) still fires", () => {
  const rand = noiseSource(7);
  for (let i = 0; i < 4; i++) {
    expect(delay(ring({ gains: MULTIPLES.map(() => 12 * rand()) }))).toBeGreaterThan(0);
  }
  // bass-heavy and treble-heavy: 8 dB per octave either way
  expect(delay(ring({ gains: MULTIPLES.map((m) => -8 * Math.log2(m / 10)) }))).toBeGreaterThan(0);
  expect(delay(ring({ gains: MULTIPLES.map((m) => 8 * Math.log2(m / 10)) }))).toBeGreaterThan(0);
});

test("fires with hiss as loud as the ring, a little later", () => {
  // the ring's rms is about 0.03; uniform noise of amplitude a has rms a / sqrt(3)
  for (const seed of [1, 2, 3]) {
    const d = delay(ring(), 0.05, seed);
    expect(d).toBeGreaterThan(0.3);
    expect(d).toBeLessThan(3);
  }
});

test("a partial that is missing costs its share and no more", () => {
  // nothing below 1 kHz, as from a small speaker: the three notes themselves are gone
  const d = delay(ring({ gains: MULTIPLES.map((m) => (m < 13 ? -60 : 0)) }));
  expect(d).toBeGreaterThan(0.3);
  expect(d).toBeLessThan(3);
});

test("a ring a little off pitch still fires, one further off does not", () => {
  expect(delay(ring({ pitch: 1.002 }))).toBeGreaterThan(0);
  expect(delay(ring({ pitch: 0.998 }))).toBeGreaterThan(0);
  for (const pitch of [0.94, 0.97, 1.03, 1.06]) expect(delay(ring({ pitch }))).toBe(-1);
});

test("the same notes at a clearly wrong tempo do not fire", () => {
  for (const tempo of [0.5, 1.5, 2]) {
    expect(fires(scene(10, [[2, ring({ tempo, seconds: 6 })]])).length).toBe(0);
  }
});

test("the same notes in another order do not fire", () => {
  const orders = {
    "low, high, low, silence": [1, 0, 1, 3],
    "high, high, low, silence": [0, 2, 1, 3],
    "high, low, silence, high": [0, 1, 3, 2],
    "low, silence, low, silence": [1, 3, 1, 3],
  };
  for (const order of Object.values(orders)) expect(delay(ring({ order }))).toBe(-1);
});

test("notes, tunes and noise that are not the ring do not fire", () => {
  const not: Record<string, Float32Array> = {
    "held G4": note(G4, 10, 20),
    "held G5": note(G5, 10, 20),
    "held chord": chord([G4, Bb4, G5], 10),
    "G4 pulsing at the ring's tempo": sequence([note(G4, 0.4, 20), 0.124], 10),
    "trill G5 G4": sequence([note(G5, 0.131), note(G4, 0.131)], 10),
    "two-tone siren on the ring's notes": sequence([note(G5, 0.262, 8), note(G4, 0.262, 8)], 10),
    "the ring's tune two semitones up": sequence(
      [note(G5 * 1.1225, 0.135), chord([G4 * 1.1225, Bb4 * 1.1225], 0.13), note(G5 * 1.1225, 0.135), 0.124],
      10
    ),
    "telephone": sequence([chord([400, 450], 0.4), 0.2, chord([400, 450], 0.4), 2], 10),
  };
  for (const [name, x] of Object.entries(not)) expect([name, fires(scene(14, [[2, x]])).length]).toEqual([name, 0]);
  expect(fires(scene(10, [], 0.3)).length).toBe(0);
});

test("the cooldown stops a second fire for a second ring soon after", () => {
  const x = scene(20, [[2, ring()], [10, ring()]]);
  expect(fires(x).length).toBe(1);
  expect(fires(x, { cooldownS: 5 }).length).toBe(2);
});

test("ring-like sound is reported with how close it came, fired or not", () => {
  const x = scene(8, [[2, ring()]]);
  const fired = events(x).filter((e) => e.type === "activity");
  expect(fired.length).toBe(1);
  expect(fired[0]).toMatchObject({ fired: true });
  expect(fired[0]!.type === "activity" && fired[0]!.margin).toBeGreaterThan(0);
  expect(fired[0]!.type === "activity" && fired[0]!.startT).toBeLessThan(2.6);

  // a stricter matcher does not fire on the synthetic ring, but still reports the near miss
  const near = events(x, { margin: 0.45 });
  expect(near.filter((e) => e.type === "ring").length).toBe(0);
  const act = near.filter((e) => e.type === "activity");
  expect(act.length).toBe(1);
  expect(act[0]).toMatchObject({ fired: false });
  expect(act[0]!.type === "activity" && act[0]!.margin).toBeLessThan(0);
});

test("the sample rate of the synthetic ring matches the matcher", () => {
  expect(SR).toBe(16000);
});
