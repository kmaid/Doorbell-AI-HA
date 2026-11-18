/**
 * Matcher for the intercom ring, built on the ring's three notes.
 *
 * The ring repeats a 0.524 s cycle: a high note (781 Hz), a low note (391 Hz) with
 * a middle note (469 Hz) beside it, the high note again and louder, then silence.
 * Every partial of those notes sits on a 78.125 Hz grid, and each one rises and
 * falls through the cycle in its own way. TEMPLATE below is that course for eleven
 * partials, measured from 8 real rings.
 *
 * For each partial the matcher asks how well its strength over the last while
 * follows its line of the template, as a correlation. That makes every partial
 * its own judge: how loud the ring is, and how loud one partial is against
 * another, cancel out. Two scores come from it:
 *
 *   rhythm  the whole cycle, silence included
 *   notes   only the sounding part, which is where the order of the notes shows
 *           (a buzz at the right pitch pulsing at the right tempo has the rhythm
 *           but not the notes)
 *
 * Each is the average over the partials, so a partial lost in noise costs its
 * share and no more. The score is the lower of the two, between 0 and 1.
 *
 * Several window lengths are scored at once, from one cycle to five. A short
 * window must score higher to fire than a long one, so a clear ring fires after
 * its first full cycle and one half buried in noise fires a second or two later.
 */
export const SAMPLE_RATE = 16000;
const WIN = 2048; // 128 ms analysis window, 7.8125 Hz per bin: the 78.125 Hz grid is every 10th bin
const HOP = 256; // one frame every 16 ms
const FRAME_S = HOP / SAMPLE_RATE;
const CYCLE = 8384; // samples in one cycle of the ring (0.524 s)
const PHASES = 32; // the cycle is cut into this many steps
const BURST = 24; // steps 0 to 23 sound (0.39 s), 24 to 31 are the silence

/** The partials that are followed, as multiples of 78.125 Hz: 391, 469, 781, 1172 ... 3906 Hz. */
export const PARTIALS = [5, 6, 10, 15, 20, 25, 30, 35, 40, 45, 50];
const C = PARTIALS.length;

/**
 * How far each partial stands above the spectrum beside it, in dB, at each step
 * of the cycle. Median of 44 cycles from 8 rings recorded on 2026-11-18. Step 0
 * is where the first high note starts.
 */
// prettier-ignore
const TEMPLATE = [
  [10, 3, 23, 9, 19, 11, 25, 12, 14, 13, 14], [9, 1, 27, 15, 21, 18, 28, 16, 15, 16, 15],
  [13, 1, 30, 19, 23, 24, 30, 19, 18, 18, 16], [19, 8, 31, 22, 27, 28, 32, 21, 20, 20, 16],
  [23, 14, 31, 24, 29, 30, 33, 22, 21, 21, 16], [24, 17, 31, 23, 28, 31, 34, 22, 22, 22, 16],
  [23, 17, 28, 19, 25, 31, 33, 22, 20, 22, 14], [21, 16, 25, 11, 22, 28, 31, 21, 15, 21, 9],
  [20, 15, 21, 6, 21, 27, 28, 21, 8, 21, 4], [20, 16, 19, 15, 22, 26, 25, 23, 12, 19, 2],
  [23, 17, 19, 20, 23, 27, 24, 26, 18, 18, 4], [26, 19, 20, 25, 25, 26, 26, 27, 22, 17, 8],
  [28, 20, 21, 29, 26, 26, 28, 28, 23, 16, 10], [28, 19, 20, 29, 25, 26, 28, 27, 24, 15, 12],
  [28, 17, 19, 28, 23, 25, 27, 24, 22, 12, 15], [28, 13, 21, 27, 20, 22, 28, 19, 19, 8, 19],
  [28, 9, 24, 26, 20, 20, 31, 12, 14, 6, 23], [28, 7, 29, 25, 23, 18, 35, 13, 6, 5, 26],
  [26, 7, 32, 24, 25, 15, 39, 19, 13, 5, 30], [23, 6, 34, 26, 29, 18, 40, 23, 20, 8, 33],
  [19, 5, 36, 27, 31, 24, 40, 23, 24, 12, 35], [17, 4, 35, 25, 30, 28, 40, 23, 27, 16, 35],
  [17, 3, 30, 21, 25, 27, 40, 19, 25, 18, 30], [16, 3, 26, 18, 20, 24, 37, 14, 21, 17, 25],
  [16, 4, 21, 15, 15, 22, 33, 9, 18, 17, 20], [16, 3, 14, 14, 10, 20, 30, 2, 15, 18, 18],
  [16, 2, 9, 14, 5, 16, 25, 6, 13, 18, 20], [14, 1, 13, 15, 6, 8, 23, 6, 13, 18, 21],
  [11, 1, 12, 15, 7, 6, 25, 3, 13, 18, 19], [7, 1, 7, 14, 8, 9, 23, 6, 6, 14, 17],
  [6, 2, 7, 9, 12, 5, 23, 7, 10, 6, 14], [9, 2, 17, 4, 15, 5, 23, 8, 12, 10, 14],
];

export interface MatcherWindow {
  /** Window length in frames of 16 ms. One cycle of the ring is 32.75 frames. */
  frames: number;
  /** The highest score that anything other than the ring reached in this window (see AGENTS.md). */
  ceiling: number;
}

export interface MatcherConfig {
  /** Shortest first. */
  windows: MatcherWindow[];
  /**
   * A window fires when its score is this far above its ceiling. Real rings at the
   * hallway microphone score about 0.9 in every window. Larger is stricter; smaller
   * finds more rings under heavy noise and gets closer to what music can reach.
   */
  margin: number;
  /** A score within this much of firing is reported as ring-like sound. */
  nearMargin: number;
  cooldownS: number;
}

export const defaultMatcherConfig: MatcherConfig = {
  windows: [
    { frames: 33, ceiling: 0.53 }, // 1 cycle, 0.53 s
    { frames: 49, ceiling: 0.47 }, // 1.5 cycles, 0.78 s
    { frames: 66, ceiling: 0.39 }, // 2 cycles, 1.06 s
    { frames: 98, ceiling: 0.34 }, // 3 cycles, 1.57 s
    { frames: 131, ceiling: 0.29 }, // 4 cycles, 2.10 s
    { frames: 164, ceiling: 0.27 }, // 5 cycles, 2.62 s
  ],
  margin: 0.1,
  nearMargin: 0.1,
  cooldownS: 30,
};

export type MatcherEvent =
  | {
      type: "ring";
      t: number;
      /** Length of the window that fired, in seconds, and what it scored against which threshold. */
      windowS: number;
      score: number;
      threshold: number;
      /** How many of the eleven partials followed the template (correlation of 0.5 or more). */
      partials: number;
    }
  /**
   * A stretch of ring-like sound has ended (one second after the score dropped away).
   * `margin` is the best score reached minus the threshold of its window: zero or more
   * means it fired, just below zero is a near miss or a near false alarm.
   */
  | { type: "activity"; t: number; startT: number; windowS: number; score: number; margin: number; fired: boolean };

// ---- FFT (radix 2, tables built once) ------------------------------------------------

const COS = new Float64Array(WIN / 2);
const SIN = new Float64Array(WIN / 2);
const REV = new Uint16Array(WIN);
for (let i = 0; i < WIN / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / WIN);
  SIN[i] = Math.sin((2 * Math.PI * i) / WIN);
}
for (let i = 0, bits = Math.log2(WIN); i < WIN; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
  REV[i] = r;
}
const HANN = Float64Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN));

/** In place. `re` holds the input in bit-reversed order, `im` is zero. */
function fft(re: Float64Array, im: Float64Array) {
  for (let size = 2; size <= WIN; size <<= 1) {
    const half = size >> 1, step = WIN / size;
    for (let s = 0; s < WIN; s += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = s + k, b = a + half;
        const xr = re[b]! * COS[t]! + im[b]! * SIN[t]!, xi = im[b]! * COS[t]! - re[b]! * SIN[t]!;
        re[b] = re[a]! - xr; im[b] = im[a]! - xi;
        re[a] = re[a]! + xr; im[a] = im[a]! + xi;
      }
    }
  }
}

// ---- running sums ----------------------------------------------------------------------
//
// Every score is a correlation over the last W frames, for 32 possible positions of the
// cycle. All of them come from sums over those frames, and each sum is kept as a running
// total since the start: a window's sum is the newest total minus the one W frames back.
// Strengths are whole numbers (0.2 dB steps) and so is the template, so the totals are
// exact and never drift.
//
// One slot of history holds, per partial c and cycle position p:
const N_PC = 8; // z*T, T, T*T over all frames; z*T, T, T*T, z, z*z over burst frames only
const O_ZT = 0, O_T = 1, O_TT = 2, O_BZT = 3, O_BT = 4, O_BTT = 5, O_BZ = 6, O_BZZ = 7;
const PC = PHASES * C;
// then z and z*z per partial, then the number of burst frames per cycle position
const O_Z = N_PC * PC, O_ZZ = O_Z + C, O_NB = O_ZZ + C;
const SLOT = O_NB + PHASES;

export class RingMatcher {
  /** Score at which each window fires. */
  readonly thresholds: number[];
  /** Score of each window after the latest frame (0 until the window has filled). */
  readonly scores: number[];
  private buf = new Float64Array(WIN);
  private filled = 0;
  private frames = 0;
  private re = new Float64Array(WIN);
  private im = new Float64Array(WIN);
  private power = new Float64Array(WIN / 2 + 1);
  private flank = new Float64Array(32);
  private z = new Float64Array(C);
  private hist: Float64Array;
  private slots: number;
  private cooldown = 0;
  private varz = new Float64Array(C);
  private sz = new Float64Array(C);
  // current stretch of ring-like sound, for the activity log
  private act: { start: number; last: number; margin: number; score: number; windowS: number; fired: boolean } | null = null;

  constructor(readonly cfg: MatcherConfig = defaultMatcherConfig) {
    this.thresholds = cfg.windows.map((w) => w.ceiling + cfg.margin);
    this.scores = cfg.windows.map(() => 0);
    this.slots = Math.max(...cfg.windows.map((w) => w.frames)) + 1;
    this.hist = new Float64Array(this.slots * SLOT);
  }

  /** Feed mono samples at 16 kHz, in any scale: only ratios matter. */
  push(samples: Float32Array | Float64Array | Int16Array): MatcherEvent[] {
    const out: MatcherEvent[] = [];
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

  /**
   * How far each partial stands above the spectrum beside it, 0 to 40 dB in steps of 0.2:
   * the partial's own bin against the median of the bins 31 to 148 Hz either side. Only
   * the exact bin is read. The ring's pitch is the same to within 0.001% from ring to ring,
   * and searching around it lets noise in.
   */
  private strengths() {
    const { re, im, power: P, flank } = this;
    im.fill(0);
    for (let i = 0; i < WIN; i++) re[REV[i]!] = this.buf[i]! * HANN[i]!;
    fft(re, im);
    const top = PARTIALS[C - 1]! * 10 + 19;
    for (let i = 0; i <= top; i++) P[i] = re[i]! * re[i]! + im[i]! * im[i]!;
    for (let j = 0; j < C; j++) {
      const c = PARTIALS[j]! * 10;
      for (let d = 4, k = 0; d <= 19; d++) {
        flank[k++] = P[c - d]!;
        flank[k++] = P[c + d]!;
      }
      flank.sort();
      const floor = (flank[15]! + flank[16]!) / 2;
      const db = 10 * Math.log10((P[c]! + 1e-20) / (floor + 1e-20));
      this.z[j] = Math.round(Math.min(40, Math.max(0, db)) * 5);
    }
  }

  private frame(out: MatcherEvent[]) {
    this.strengths();
    const n = this.frames++;
    const t = (n * HOP + WIN) / SAMPLE_RATE;
    const { hist, slots, z } = this;

    // New running totals: the previous ones plus this frame.
    const cur = ((n + 1) % slots) * SLOT, prev = (n % slots) * SLOT;
    hist.copyWithin(cur, prev, prev + SLOT);
    const phase = Math.floor(((n * HOP) % CYCLE) / (CYCLE / PHASES));
    for (let p = 0; p < PHASES; p++) {
      const q = (phase + p) % PHASES, row = TEMPLATE[q]!, burst = q < BURST;
      let o = cur + p * C * N_PC;
      for (let c = 0; c < C; c++, o += N_PC) {
        const T = row[c]!, zc = z[c]!;
        hist[o + O_ZT]! += zc * T;
        hist[o + O_T]! += T;
        hist[o + O_TT]! += T * T;
        if (burst) {
          hist[o + O_BZT]! += zc * T;
          hist[o + O_BT]! += T;
          hist[o + O_BTT]! += T * T;
          hist[o + O_BZ]! += zc;
          hist[o + O_BZZ]! += zc * zc;
        }
      }
      if (burst) hist[cur + O_NB + p]!++;
    }
    for (let c = 0; c < C; c++) {
      hist[cur + O_Z + c]! += z[c]!;
      hist[cur + O_ZZ + c]! += z[c]! * z[c]!;
    }

    // Score every window; note the one that comes closest to (or furthest past) its threshold.
    let best = -Infinity, bestScore = 0, bestW = 0, bestPartials = 0, fire = -1;
    for (let w = 0; w < this.cfg.windows.length; w++) {
      const W = this.cfg.windows[w]!.frames;
      if (n + 1 < W) break;
      const r = this.score(cur, ((n + 1 - W) % slots) * SLOT, W);
      this.scores[w] = r.score;
      const m = r.score - this.thresholds[w]!;
      // the shortest window that reaches its threshold is the one that fires
      if (fire < 0 && m > best) { best = m; bestScore = r.score; bestW = w; bestPartials = r.partials; }
      if (fire < 0 && m >= 0) fire = w;
    }

    let fired = false;
    if (this.cooldown > 0) this.cooldown--;
    else if (fire >= 0) {
      fired = true;
      this.cooldown = Math.round(this.cfg.cooldownS / FRAME_S);
      out.push({
        type: "ring",
        t,
        windowS: this.cfg.windows[fire]!.frames * FRAME_S,
        score: bestScore,
        threshold: this.thresholds[fire]!,
        partials: bestPartials,
      });
    }

    if (best >= -this.cfg.nearMargin) {
      const windowS = this.cfg.windows[bestW]!.frames * FRAME_S;
      this.act ??= { start: t - windowS, last: 0, margin: -Infinity, score: 0, windowS, fired: false };
      this.act.last = this.frames;
      if (best > this.act.margin) Object.assign(this.act, { margin: best, score: bestScore, windowS });
    }
    if (this.act) {
      if (fired) this.act.fired = true;
      if (this.frames - this.act.last > 1 / FRAME_S) {
        const a = this.act;
        out.push({ type: "activity", t, startT: a.start, windowS: a.windowS, score: a.score, margin: a.margin, fired: a.fired });
        this.act = null;
      }
    }
  }

  /** Score of the window between two slots of running totals: the best over the 32 cycle positions. */
  private score(cur: number, old: number, W: number) {
    const { hist, varz, sz } = this;
    for (let c = 0; c < C; c++) {
      const s = hist[cur + O_Z + c]! - hist[old + O_Z + c]!;
      sz[c] = s;
      varz[c] = Math.max(hist[cur + O_ZZ + c]! - hist[old + O_ZZ + c]! - (s * s) / W, 1e-9);
    }
    let bestScore = -1, bestP = 0;
    for (let p = 0; p < PHASES; p++) {
      const nb = Math.max(hist[cur + O_NB + p]! - hist[old + O_NB + p]!, 1);
      let rhythm = 0, notes = 0;
      let a = cur + p * C * N_PC, b = old + p * C * N_PC;
      for (let c = 0; c < C; c++, a += N_PC, b += N_PC) {
        const st = hist[a + O_T]! - hist[b + O_T]!;
        const vt = Math.max(hist[a + O_TT]! - hist[b + O_TT]! - (st * st) / W, 1e-9);
        const r = (hist[a + O_ZT]! - hist[b + O_ZT]! - (sz[c]! * st) / W) / Math.sqrt(varz[c]! * vt);
        if (r > 0) rhythm += r;
        const bz = hist[a + O_BZ]! - hist[b + O_BZ]!, bt = hist[a + O_BT]! - hist[b + O_BT]!;
        const vbz = Math.max(hist[a + O_BZZ]! - hist[b + O_BZZ]! - (bz * bz) / nb, 1e-9);
        const vbt = Math.max(hist[a + O_BTT]! - hist[b + O_BTT]! - (bt * bt) / nb, 1e-9);
        const rn = (hist[a + O_BZT]! - hist[b + O_BZT]! - (bz * bt) / nb) / Math.sqrt(vbz * vbt);
        if (rn > 0) notes += rn;
      }
      const s = Math.min(rhythm, notes) / C;
      if (s > bestScore) { bestScore = s; bestP = p; }
    }
    // how many partials follow the template at that position
    let partials = 0;
    let a = cur + bestP * C * N_PC, b = old + bestP * C * N_PC;
    for (let c = 0; c < C; c++, a += N_PC, b += N_PC) {
      const st = hist[a + O_T]! - hist[b + O_T]!;
      const vt = Math.max(hist[a + O_TT]! - hist[b + O_TT]! - (st * st) / W, 1e-9);
      if ((hist[a + O_ZT]! - hist[b + O_ZT]! - (sz[c]! * st) / W) / Math.sqrt(varz[c]! * vt) >= 0.5) partials++;
    }
    return { score: bestScore, partials };
  }
}
