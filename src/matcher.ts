/**
 * Matcher for the intercom ring, built on the ring's three notes.
 *
 * The ring repeats a 0.524 s cycle: a high note (781 Hz), a low note (391 Hz) with
 * a middle note (469 Hz) beside it, the high note again and louder, then silence.
 * Every partial of those notes sits on a 78.125 Hz grid, and each one rises and
 * falls through the cycle in its own way. TEMPLATE below is that course for eleven
 * partials, measured from real rings.
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
 * of the cycle. Step 0 is where the first high note starts.
 *
 * What the microphone hears of the ring changes when the microphone moves: after
 * it had been lifted and put back on 2026-11-19, some partials arrived 6 to 20 dB
 * weaker and several followed a different course through the cycle. This is the
 * average of the two states seen so far, weighted equally: the median of 44 cycles
 * from 8 rings on 2026-11-18 and the mean of 2 rings on 2026-11-19. Rings of either
 * day score 0.8 to 0.9 against it, where each scored 0.95 against its own day's
 * course and 0.6 against the other's.
 */
// prettier-ignore
const TEMPLATE = [
  [8, 3, 23, 10, 16, 14, 18, 9, 15, 14, 14], [9, 2, 27, 14, 19, 19, 19, 12, 17, 16, 16],
  [13, 1, 30, 16, 21, 23, 19, 14, 20, 18, 17], [18, 4, 31, 18, 25, 26, 22, 17, 22, 20, 18],
  [21, 7, 32, 19, 27, 29, 24, 20, 24, 21, 18], [21, 10, 31, 17, 26, 30, 27, 21, 24, 21, 19],
  [20, 10, 28, 12, 23, 29, 27, 20, 23, 21, 17], [18, 10, 25, 8, 19, 26, 25, 18, 18, 20, 12],
  [17, 10, 21, 7, 17, 24, 23, 18, 13, 19, 7], [18, 10, 19, 14, 15, 23, 22, 19, 12, 18, 5],
  [21, 9, 19, 19, 14, 23, 20, 21, 12, 17, 7], [22, 10, 20, 23, 18, 23, 20, 23, 15, 17, 9],
  [24, 11, 20, 26, 19, 23, 20, 24, 17, 17, 10], [24, 11, 20, 27, 19, 23, 18, 24, 18, 16, 11],
  [24, 11, 20, 26, 17, 23, 18, 21, 17, 14, 11], [24, 9, 21, 24, 15, 20, 20, 16, 14, 11, 16],
  [24, 7, 25, 23, 16, 20, 23, 12, 11, 10, 21], [23, 6, 29, 21, 19, 18, 25, 10, 7, 8, 24],
  [21, 4, 31, 20, 21, 17, 28, 14, 12, 8, 28], [18, 3, 33, 20, 23, 18, 30, 18, 17, 10, 30],
  [13, 3, 34, 18, 25, 21, 30, 18, 20, 13, 32], [12, 3, 33, 17, 24, 23, 30, 17, 22, 15, 33],
  [13, 3, 30, 15, 20, 21, 26, 12, 20, 16, 29], [12, 3, 26, 13, 15, 17, 26, 8, 16, 13, 24],
  [13, 3, 21, 12, 11, 14, 25, 5, 14, 11, 21], [13, 3, 13, 11, 6, 12, 25, 2, 12, 11, 18],
  [14, 2, 14, 11, 4, 10, 23, 5, 11, 12, 17], [12, 1, 17, 11, 6, 6, 23, 6, 11, 13, 19],
  [10, 1, 17, 11, 8, 5, 26, 5, 12, 12, 19], [8, 2, 13, 11, 8, 6, 25, 4, 8, 9, 19],
  [7, 2, 11, 9, 11, 6, 22, 4, 11, 7, 15], [7, 3, 18, 6, 13, 9, 19, 6, 13, 11, 13],
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
   * hallway microphone score 0.8 to 0.9 in every window. Larger is stricter; smaller
   * finds more rings under heavy noise and gets closer to what music can reach.
   */
  margin: number;
  /** A score within this much of firing is reported as ring-like sound. */
  nearMargin: number;
  cooldownS: number;
}

export const defaultMatcherConfig: MatcherConfig = {
  windows: [
    { frames: 33, ceiling: 0.56 }, // 1 cycle, 0.53 s
    { frames: 49, ceiling: 0.45 }, // 1.5 cycles, 0.78 s
    { frames: 66, ceiling: 0.40 }, // 2 cycles, 1.06 s
    { frames: 98, ceiling: 0.32 }, // 3 cycles, 1.57 s
    { frames: 131, ceiling: 0.31 }, // 4 cycles, 2.10 s
    { frames: 164, ceiling: 0.26 }, // 5 cycles, 2.62 s
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
