/**
 * Listens for the washing machine's "finished" beep.
 *
 * Measured on 2026-11-19 through the hallway microphone: a pure tone at 3998 Hz,
 * two beeps of 0.517 s whose starts are 1.040 s apart, and that pair again every
 * 17.19 s (four pairs, then three more a few minutes later). The timing was the
 * same to within 0.01 s and the pitch to within 0.3 Hz across all seven pairs.
 *
 * Every 16 ms the tone at 4 kHz is measured against the spectrum beside it. One
 * pair is recognised by how well the last 3.6 s of that measurement follow the
 * pair's shape (a second of silence, beep, gap, beep, a second of silence), as a
 * correlation, by the silences really being quieter than the beeps, which a longer
 * run of beeps is not, and by the pitch holding still during both beeps, which
 * music and speech at 4 kHz do not do.
 *
 * One pair alone is only reported. The machine counts as finished when two pairs
 * are heard one, two or three periods of 17.19 s apart at the same pitch.
 */
import { SAMPLE_RATE } from "./matcher";

const WIN = 2048; // 128 ms, 7.8125 Hz per bin
const HOP = 256; // one frame every 16 ms
const FRAME_S = HOP / SAMPLE_RATE;
const BIN_HZ = SAMPLE_RATE / WIN;
const CENTRE = 512; // 4000 Hz
const SPAN = 19; // bins either side that are read

// The pair's shape, in seconds.
// The silences either side are longer than the gap, so a third beep in step with the two would land in them.
const LEAD_S = 1.0, BEEP_S = 0.517, GAP_S = 0.523, TAIL_S = 1.0;
/** Seconds from the start of one pair to the start of the next. */
export const PAIR_PERIOD_S = 17.19;

/** Frames in the window that one pair is judged over (3.56 s). */
const N = Math.round((LEAD_S + 2 * BEEP_S + GAP_S + TAIL_S) / FRAME_S);
/** Expected strength of the tone through the window, 0 to 1, blurred as the 128 ms analysis blurs it. */
const SHAPE = (() => {
  const square = Float64Array.from({ length: N }, (_, i) => {
    const t = (i + 0.5) * FRAME_S - LEAD_S;
    return (t >= 0 && t < BEEP_S) || (t >= BEEP_S + GAP_S && t < 2 * BEEP_S + GAP_S) ? 1 : 0;
  });
  const blur = Float64Array.from({ length: 9 }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 8));
  const sum = blur.reduce((a, b) => a + b, 0);
  return square.map((_, i) => {
    let acc = 0;
    for (let k = 0; k < 9; k++) acc += (square[i + k - 4] ?? 0) * blur[k]!;
    return acc / sum;
  });
})();
const SHAPE_MEAN = SHAPE.reduce((a, b) => a + b, 0) / N;
const SHAPE_SD = Math.sqrt(SHAPE.reduce((a, b) => a + (b - SHAPE_MEAN) ** 2, 0) / N);
/** Frames where the tone is fully on, split into the two beeps, and frames where it is fully off. */
const ON = [...SHAPE.keys()].filter((i) => SHAPE[i]! > 0.9);
const BEEP1 = ON.slice(0, ON.length >> 1), BEEP2 = ON.slice(ON.length >> 1);
const OFF = [...SHAPE.keys()].filter((i) => SHAPE[i]! < 0.1);
/** Frames where a beep before the first or after the second would sound, if the beeps carried on in step. */
const GUARD_S = 0.45;
const BEFORE = OFF.filter((i) => (i + 0.5) * FRAME_S < GUARD_S);
const AFTER = OFF.filter((i) => (i + 0.5) * FRAME_S > N * FRAME_S - GUARD_S);

// Windowed sine and cosine for each bin that is read, so no full spectrum is needed.
const BINS = 2 * SPAN + 1;
const TAB_RE = new Float64Array(BINS * WIN), TAB_IM = new Float64Array(BINS * WIN);
for (let b = 0; b < BINS; b++) {
  for (let i = 0; i < WIN; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
    const a = (2 * Math.PI * ((CENTRE - SPAN + b) * i)) / WIN;
    TAB_RE[b * WIN + i] = hann * Math.cos(a);
    TAB_IM[b * WIN + i] = hann * Math.sin(a);
  }
}

export interface WasherConfig {
  /** One pair counts when the tone follows the pair's shape at least this well (correlation, 0 to 1) ... */
  minScore: number;
  /** ... the tone stands at least this many dB above the spectrum beside it during the beeps ... */
  minLevelDb: number;
  /** ... the beeps are this many dB stronger than the silences ... */
  minDepthDb: number;
  /** ... the half second where a third beep in step would be, before and after, is this many dB below the beeps ... */
  minQuietDb: number;
  /** ... and the pitch wanders no more than this many Hz within a beep or between the two. */
  maxWobbleHz: number;
  /** Two pairs belong together when they are a whole number of periods apart, give or take this. */
  periodToleranceS: number;
  /** How many periods apart they may be, so one or two pairs lost in noise do not matter. */
  maxPeriods: number;
  /** ... and their pitch differs by no more than this. */
  maxPitchDiffHz: number;
  /** A pair that falls short is still reported when its shape scores this well. */
  nearScore: number;
  /** After "finished", further pairs are reported but do not finish again for this long. */
  cooldownS: number;
}

export const defaultWasherConfig: WasherConfig = {
  minScore: 0.7,
  minLevelDb: 10,
  minDepthDb: 6,
  minQuietDb: 4,
  maxWobbleHz: 1.5,
  periodToleranceS: 0.35,
  maxPeriods: 3,
  maxPitchDiffHz: 1,
  nearScore: 0.7,
  cooldownS: 600,
};

export interface WasherPair {
  /** Stream time in seconds at which the first beep started. */
  startT: number;
  /** How well the tone followed the pair's shape, 0 to 1. Real pairs measured 0.90 to 0.96. */
  score: number;
  /** dB by which the tone stood above the spectrum beside it during the beeps (10th percentile). */
  levelDb: number;
  /** dB between the beeps and the silences around them. */
  depthDb: number;
  /** dB between the beeps and the louder of the two half seconds where a beep before or after them would be. */
  quietDb: number;
  pitchHz: number;
  /** Largest of: mean wander of the pitch within either beep, and the difference between the two beeps. */
  wobbleHz: number;
  /** Whether it met every condition for one pair. */
  accepted: boolean;
}

export type WasherEvent =
  /** A pair, or something close to one, has been heard (reported about a second after it ends). */
  | ({ type: "pair"; t: number } & WasherPair)
  /** Two pairs the right distance apart: the machine has finished. */
  | { type: "finished"; t: number; first: WasherPair; second: WasherPair; periods: number };

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b), h = s.length >> 1;
  return s.length & 1 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
};

const percentile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b), k = q * (s.length - 1), k0 = Math.floor(k);
  return s[k0]! + (k - k0) * (s[Math.min(k0 + 1, s.length - 1)]! - s[k0]!);
};

export class WasherListener {
  private buf = new Float64Array(WIN);
  private filled = 0;
  private frames = 0;
  // tone strength (0 to 40 dB) and pitch (Hz away from 4000) of the last N frames
  private level = new Float64Array(N);
  private pitch = new Float64Array(N);
  private power = new Float64Array(BINS);
  private flank = new Float64Array(2 * (SPAN - 3));
  // the best-scoring window of the current stretch of pair-like sound
  private best: (WasherPair & { last: number }) | null = null;
  private pairs: WasherPair[] = [];
  private quietUntil = -Infinity;

  constructor(readonly cfg: WasherConfig = defaultWasherConfig) {}

  /** Feed mono samples at 16 kHz, in any scale: only ratios matter. */
  push(samples: Float32Array | Float64Array | Int16Array): WasherEvent[] {
    const out: WasherEvent[] = [];
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.filled++] = samples[i]!;
      if (this.filled === WIN) {
        this.frame(out);
        this.buf.copyWithin(0, HOP);
        this.filled = WIN - HOP;
      }
    }
    return out;
  }

  /** Strength and pitch of the tone in the newest 128 ms. */
  private measure(slot: number) {
    const { buf, power: P, flank } = this;
    for (let b = 0; b < BINS; b++) {
      // the bins 23 Hz either side of the three in the middle are not used
      if (b !== SPAN && Math.abs(b - SPAN) > 1 && Math.abs(b - SPAN) < 4) continue;
      let re = 0, im = 0;
      for (let i = 0, o = b * WIN; i < WIN; i++, o++) {
        re += buf[i]! * TAB_RE[o]!;
        im += buf[i]! * TAB_IM[o]!;
      }
      P[b] = re * re + im * im + 1e-12;
    }
    for (let d = 4, k = 0; d <= SPAN; d++) {
      flank[k++] = P[SPAN - d]!;
      flank[k++] = P[SPAN + d]!;
    }
    flank.sort();
    const floor = (flank[flank.length / 2 - 1]! + flank[flank.length / 2]!) / 2;
    const lo = P[SPAN - 1]!, mid = P[SPAN]!, hi = P[SPAN + 1]!;
    const db = 10 * Math.log10(Math.max(lo, mid, hi) / floor);
    this.level[slot] = Math.min(40, Math.max(0, db));
    // pitch from a parabola through the three bins
    const a = Math.log(lo), b = Math.log(mid), c = Math.log(hi);
    const curve = a - 2 * b + c;
    const off = curve === 0 ? 0 : (0.5 * (a - c)) / curve;
    this.pitch[slot] = Math.min(2, Math.max(-2, off)) * BIN_HZ;
  }

  private frame(out: WasherEvent[]) {
    const n = this.frames++;
    this.measure(n % N);
    const t = (n * HOP + WIN) / SAMPLE_RATE;

    if (n + 1 >= N) {
      // The window is the last N frames; frame i of it sits in slot (first + i) % N.
      const first = (n + 1) % N;
      const { level, pitch } = this;
      let sum = 0, sq = 0, dot = 0;
      for (let i = 0; i < N; i++) {
        const v = level[(first + i) % N]!;
        sum += v;
        sq += v * v;
        dot += v * SHAPE[i]!;
      }
      const mean = sum / N, sd = Math.sqrt(Math.max(sq / N - mean * mean, 0)) + 1e-6;
      const score = (dot / N - mean * SHAPE_MEAN) / (sd * SHAPE_SD);
      const at = (idx: number[], of: Float64Array) => idx.map((i) => of[(first + i) % N]!);
      const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
      const on = at(ON, level);
      const off = at(OFF, level);
      const depthDb = avg(on) - avg(off);

      if (score >= 0.5 && depthDb >= 3) {
        if (!this.best || score > this.best.score) {
          const levelDb = percentile(on, 0.1);
          const quietDb = avg(on) - Math.max(avg(at(BEFORE, level)), avg(at(AFTER, level)));
          const p1 = at(BEEP1, pitch), p2 = at(BEEP2, pitch);
          const m1 = median(p1), m2 = median(p2);
          const wander = (v: number[], m: number) => avg(v.map((x) => Math.abs(x - m)));
          const wobbleHz = Math.max(wander(p1, m1), wander(p2, m2), Math.abs(m1 - m2));
          const { cfg } = this;
          this.best = {
            last: n,
            // the window starts LEAD_S before the first beep; a frame is timed by its middle
            startT: ((n + 1 - N) * HOP + WIN / 2) / SAMPLE_RATE + LEAD_S,
            score,
            levelDb,
            depthDb,
            quietDb,
            pitchHz: CENTRE * BIN_HZ + (m1 + m2) / 2,
            wobbleHz,
            accepted:
              score >= cfg.minScore && levelDb >= cfg.minLevelDb && depthDb >= cfg.minDepthDb &&
              quietDb >= cfg.minQuietDb && wobbleHz <= cfg.maxWobbleHz,
          };
        }
        this.best.last = n;
      }
    }

    // A stretch of pair-like sound ends after a second without any; its best window is the pair.
    if (this.best && n - this.best.last >= 60) {
      const { last: _, ...pair } = this.best;
      this.best = null;
      if (pair.accepted || (pair.score >= this.cfg.nearScore && pair.depthDb >= this.cfg.minDepthDb)) {
        out.push({ type: "pair", t, ...pair });
      }
      if (pair.accepted) this.accept(pair, t, out);
    }
  }

  private accept(pair: WasherPair, t: number, out: WasherEvent[]) {
    const { cfg } = this;
    this.pairs = this.pairs.filter((p) => pair.startT - p.startT < cfg.maxPeriods * PAIR_PERIOD_S + 1);
    // the nearest earlier pair that fits
    for (let i = this.pairs.length - 1; i >= 0 && t >= this.quietUntil; i--) {
      const p = this.pairs[i]!;
      const gap = pair.startT - p.startT, periods = Math.round(gap / PAIR_PERIOD_S);
      if (
        periods >= 1 && periods <= cfg.maxPeriods &&
        Math.abs(gap - periods * PAIR_PERIOD_S) <= cfg.periodToleranceS &&
        Math.abs(pair.pitchHz - p.pitchHz) <= cfg.maxPitchDiffHz
      ) {
        out.push({ type: "finished", t, first: p, second: pair, periods });
        this.quietUntil = t + cfg.cooldownS;
        break;
      }
    }
    this.pairs.push(pair);
  }
}
