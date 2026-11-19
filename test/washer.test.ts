import { expect, test } from "bun:test";

import { PAIR_PERIOD_S, WasherListener, defaultWasherConfig, type WasherEvent } from "../src/washer";

// All audio here is synthetic: tones built from the measured description of the
// washing machine's finish beep (3998 Hz, two beeps of 0.517 s starting 1.04 s
// apart, the pair again every 17.19 s), in steady hiss.

const SR = 16000;
const PITCH = 3998;

function hiss(seconds: number, level = 0.002, seed = 1) {
  const out = new Float32Array(Math.round(seconds * SR));
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    // sum of four uniform numbers, near enough to noise
    let v = 0;
    for (let k = 0; k < 4; k++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      v += s / 2 ** 32 - 0.5;
    }
    out[i] = v * level;
  }
  return out;
}

/** Adds a tone with 5 ms ramps. `vibratoHz` swings the pitch by that much, six times a second. */
function beep(x: Float32Array, at: number, seconds: number, hz = PITCH, level = 0.02, vibratoHz = 0) {
  const start = Math.round(at * SR), n = Math.round(seconds * SR), ramp = 0.005 * SR;
  let phase = 0;
  for (let i = 0; i < n && start + i < x.length; i++) {
    phase += (2 * Math.PI * (hz + vibratoHz * Math.sin((2 * Math.PI * 6 * i) / SR))) / SR;
    x[start + i]! += level * Math.min(1, i / ramp, (n - i) / ramp) * Math.sin(phase);
  }
}
const pair = (x: Float32Array, at: number, hz = PITCH, level = 0.02, vibratoHz = 0) => {
  beep(x, at, 0.517, hz, level, vibratoHz);
  beep(x, at + 1.04, 0.517, hz, level, vibratoHz);
};

function events(x: Float32Array, cfg = {}) {
  const d = new WasherListener({ ...defaultWasherConfig, ...cfg });
  const out: WasherEvent[] = [];
  // feed in uneven chunks, as a pipe would
  for (let i = 0; i < x.length; ) {
    const n = 1000 + ((i * 7) % 3000);
    out.push(...d.push(x.subarray(i, i + n)));
    i += n;
  }
  return out;
}
const finished = (x: Float32Array, cfg = {}) => events(x, cfg).filter((e) => e.type === "finished");
const pairs = (x: Float32Array) => events(x).filter((e) => e.type === "pair");

test("four pairs a period apart finish once, after the second pair", () => {
  const x = hiss(80);
  for (let k = 0; k < 4; k++) pair(x, 5 + k * PAIR_PERIOD_S);
  const f = finished(x);
  expect(f.length).toBe(1);
  // the second pair ends 18.75 s after the first one starts
  expect(f[0]!.t - 5).toBeGreaterThan(18.7);
  expect(f[0]!.t - 5).toBeLessThan(22);
  const p = pairs(x);
  expect(p.length).toBe(4);
  for (const e of p) {
    if (e.type !== "pair") continue;
    expect(e.accepted).toBe(true);
    expect(e.score).toBeGreaterThan(0.9);
    expect(Math.abs(e.pitchHz - PITCH)).toBeLessThan(0.5);
  }
  expect(Math.abs((p[0] as { startT: number }).startT - 5)).toBeLessThan(0.05);
});

test("one pair alone is reported and does not finish", () => {
  const x = hiss(30);
  pair(x, 5);
  const e = events(x);
  expect(e.filter((v) => v.type === "finished").length).toBe(0);
  expect(e.filter((v) => v.type === "pair" && v.accepted).length).toBe(1);
});

test("a pair lost in between does not matter", () => {
  const x = hiss(60);
  pair(x, 5);
  pair(x, 5 + 2 * PAIR_PERIOD_S);
  const f = finished(x);
  expect(f.length).toBe(1);
  expect(f[0]!.type === "finished" && f[0]!.periods).toBe(2);
});

test("pairs the wrong time apart do not finish", () => {
  for (const gap of [10, 16.5, 17.9, 25, 30]) {
    const x = hiss(50);
    pair(x, 5);
    pair(x, 5 + gap);
    expect(finished(x).length).toBe(0);
  }
});

test("the timing may be a little off", () => {
  for (const gap of [PAIR_PERIOD_S - 0.25, PAIR_PERIOD_S + 0.25]) {
    const x = hiss(40);
    pair(x, 5);
    pair(x, 5 + gap);
    expect(finished(x).length).toBe(1);
  }
});

test("two pairs at different pitches do not finish", () => {
  const x = hiss(40);
  pair(x, 5, 3998);
  pair(x, 5 + PAIR_PERIOD_S, 4003);
  expect(finished(x).length).toBe(0);
});

test("the pitch may sit a few Hz away, as long as both pairs agree", () => {
  for (const hz of [3992, 4004]) {
    const x = hiss(40);
    pair(x, 5, hz);
    pair(x, 5 + PAIR_PERIOD_S, hz);
    expect(finished(x).length).toBe(1);
  }
});

test("other beeping does not count as a pair", () => {
  const cases: Record<string, (x: Float32Array) => void> = {
    "one beep": (x) => beep(x, 5, 0.517),
    "three beeps in a row": (x) => [0, 1.04, 2.08].forEach((d) => beep(x, 5 + d, 0.517)),
    "a steady train of beeps": (x) => { for (let t = 2; t < 28; t += 1.04) beep(x, t, 0.517); },
    "short beeps": (x) => { beep(x, 5, 0.15); beep(x, 6.04, 0.15); },
    "long beeps": (x) => { beep(x, 5, 0.9); beep(x, 6.04, 0.9); },
    "beeps too close together": (x) => { beep(x, 5, 0.3); beep(x, 5.5, 0.3); },
    "beeps too far apart": (x) => { beep(x, 5, 0.517); beep(x, 6.8, 0.517); },
    "a held tone": (x) => beep(x, 5, 10),
    "a wavering tone": (x) => pair(x, 5, PITCH, 0.02, 6),
    "a reversing beeper at 2.9 kHz": (x) => { for (let t = 2; t < 28; t += 0.88) beep(x, t, 0.4, 2890); },
    "a pair at 3.9 kHz": (x) => pair(x, 5, 3900),
  };
  for (const [name, make] of Object.entries(cases)) {
    const x = hiss(30);
    make(x);
    // twice, a period apart, so that anything accepted as a pair would also finish
    const y = hiss(60);
    make(y);
    make(y.subarray(Math.round(PAIR_PERIOD_S * SR)));
    expect([name, pairs(x).filter((e) => e.type === "pair" && e.accepted).length, finished(y).length]).toEqual([name, 0, 0]);
  }
});

test("hiss alone gives nothing", () => {
  expect(events(hiss(120, 0.05, 7)).length).toBe(0);
});

test("pairs are found in hiss as loud as the beep, and not when it is ten times louder", () => {
  // beep level 0.02 peak; hiss with a spread of about 0.58 * level
  const make = (level: number) => {
    const x = hiss(45, level, 3);
    pair(x, 5);
    pair(x, 5 + PAIR_PERIOD_S);
    return x;
  };
  expect(finished(make(0.03)).length).toBe(1);
  expect(finished(make(3)).length).toBe(0);
});

test("after finishing it stays quiet for the cooldown, then finishes again", () => {
  const x = hiss(200);
  for (const t of [5, 5 + PAIR_PERIOD_S, 60, 60 + PAIR_PERIOD_S, 150, 150 + PAIR_PERIOD_S]) pair(x, t);
  expect(finished(x).length).toBe(1);
  expect(finished(x, { cooldownS: 100 }).length).toBe(2);
});
