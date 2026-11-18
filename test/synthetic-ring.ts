/**
 * A synthetic intercom ring for tests, built from the measured description of the
 * real one (see "The ring" in AGENTS.md). No recorded audio is involved.
 */
export const SR = 16000;
const GRID = 78.125;
const CYCLE_S = 0.524;

/** Partials as multiples of 78.125 Hz: 391, 469, 703, 781, 1094, 1172 ... 3906 Hz. */
export const MULTIPLES = [5, 6, 9, 10, 14, 15, 20, 25, 30, 35, 40, 45, 50];

/**
 * Level of each partial in dB (0 = the loudest) through one cycle in 16 steps of 33 ms.
 * Steps 0 to 3 are the first high note, 4 to 7 the low note with the middle note beside
 * it, 8 to 11 the high note again and louder, 12 to 15 the silence. -99 is off.
 */
// prettier-ignore
const LEVELS = [
  [-99, -25, -29, -10, -26, -17, -16, -35, -30, -26, -28, -39, -99],
  [-99, -28, -31, -7, -25, -16, -12, -16, -7, -21, -26, -29, -99],
  [-15, -19, -31, -7, -22, -13, -11, -13, -7, -21, -23, -27, -99],
  [-14, -16, -26, -7, -21, -16, -11, -13, -9, -21, -24, -26, -99],
  [-36, -17, -37, -16, -18, -18, -11, -12, -99, -21, -28, -27, -99],
  [-15, -15, -29, -16, -23, -12, -13, -16, -99, -17, -22, -30, -99],
  [-10, -15, -25, -20, -26, -9, -14, -18, -99, -16, -21, -33, -99],
  [-9, -16, -22, -20, -25, -7, -17, -18, -99, -17, -21, -99, -33],
  [-6, -20, -21, -4, -19, -8, -15, -19, -5, -25, -29, -99, -18],
  [-14, -24, -32, -3, -30, -11, -15, -25, 0, -23, -27, -99, -17],
  [-99, -38, -99, -3, -99, -16, -15, -23, -1, -29, -27, -99, -18],
  [-99, -99, -33, -4, -99, -19, -18, -20, -2, -29, -27, -99, -19],
  [-99, -33, -28, -16, -99, -99, -27, -21, -7, -99, -34, -99, -99],
  [-99, -99, -99, -99, -99, -99, -99, -45, -99, -99, -99, -99, -99],
  [-99, -99, -99, -99, -99, -99, -99, -99, -99, -99, -99, -99, -99],
  [-99, -39, -99, -99, -99, -99, -36, -99, -99, -41, -99, -99, -99],
];
const AMP = LEVELS.map((row) => row.map((db) => (db <= -99 ? 0 : 10 ** (db / 20))));

/** Deterministic noise, -1 to 1, so that tests do not flake. */
export function noiseSource(seed = 1) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}

export interface RingOptions {
  /** Length of the sound in seconds. Real rings ran from 3.0 to 4.7 s. */
  seconds?: number;
  /** Where in the cycle the ring picks up, 0 to 1. */
  startPhase?: number;
  /** 1.01 is 1% sharp. */
  pitch?: number;
  /** 1.1 is 10% faster. */
  tempo?: number;
  /** Extra gain per partial in dB, for a different microphone position. */
  gains?: number[];
  /** The four parts of the cycle in playing order: 0 high, 1 low and middle, 2 high again, 3 silence. */
  order?: number[];
  /** Amplitude of the loudest partial. */
  level?: number;
}

/** The repeating part of the ring. */
export function ring(o: RingOptions = {}): Float32Array {
  const { seconds = 3.2, startPhase = 0, pitch = 1, tempo = 1, gains, order = [0, 1, 2, 3], level = 0.03 } = o;
  const steps = order.flatMap((part) => [0, 1, 2, 3].map((k) => AMP[part * 4 + k]!));
  const n = Math.round(seconds * SR), out = new Float32Array(n), cycle = CYCLE_S / tempo;
  const g = MULTIPLES.map((_, i) => 10 ** ((gains?.[i] ?? 0) / 20));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // position in the cycle in steps, with the levels interpolated between step centres
    const pos = (((t / cycle + startPhase) % 1) * 16 + 15.5) % 16;
    const a = Math.floor(pos), f = pos - a, rowA = steps[a]!, rowB = steps[(a + 1) % 16]!;
    let v = 0;
    for (let k = 0; k < MULTIPLES.length; k++) {
      const amp = rowA[k]! * (1 - f) + rowB[k]! * f;
      if (amp > 0) v += g[k]! * amp * Math.sin(2 * Math.PI * MULTIPLES[k]! * GRID * pitch * t);
    }
    const fade = Math.min(1, i / 64, (n - 1 - i) / 64);
    out[i] = level * v * fade;
  }
  return out;
}

/** A plain note with overtones falling off as 1/k. */
export function note(f: number, seconds: number, partials = 12, level = 0.03): Float32Array {
  const n = Math.round(seconds * SR), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 1; k <= partials && f * k < 7500; k++) v += Math.sin((2 * Math.PI * f * k * i) / SR) / k;
    out[i] = level * v * Math.min(1, i / 128, (n - 1 - i) / 128);
  }
  return out;
}

/**
 * `total` seconds of background hiss with the sounds mixed in at their start times (seconds).
 * The default hiss sits about as far below the ring as the hallway does below the real one.
 */
export function scene(total: number, sounds: [number, Float32Array][], noise = 0.005, seed = 1): Float32Array {
  const rand = noiseSource(seed), out = new Float32Array(Math.round(total * SR));
  for (let i = 0; i < out.length; i++) out[i] = noise * rand();
  for (const [at, s] of sounds) {
    const a = Math.round(at * SR);
    for (let i = 0; i < s.length && a + i < out.length; i++) out[a + i]! += s[i]!;
  }
  return out;
}

/** Sounds one after another, repeated until `seconds` is filled. `null` is silence of the given length. */
export function sequence(parts: (Float32Array | number)[], seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let at = 0; at < out.length; ) {
    for (const p of parts) {
      if (typeof p === "number") at += Math.round(p * SR);
      else {
        for (let i = 0; i < p.length && at + i < out.length; i++) out[at + i] = p[i]!;
        at += p.length;
      }
    }
  }
  return out;
}
