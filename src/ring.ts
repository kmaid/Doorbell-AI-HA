/**
 * Deterministic detector for the intercom ring.
 *
 * The ring is a buzz at about 391 Hz with strong multiples of that pitch,
 * pulsing in bursts of roughly 0.45 s separated by gaps of roughly 0.08 s,
 * for about 3.3 s. The detector looks only at where the spectral peaks are
 * and how they pulse, never at how loud anything is, so it does not care
 * where the microphone sits or how much broadband noise is around.
 */
export const SAMPLE_RATE = 16000;
const N = 1024; // 64 ms analysis window
const HOP = 256; // one frame every 16 ms
const BIN = SAMPLE_RATE / N;
const FRAME_S = HOP / SAMPLE_RATE;

export interface RingConfig {
  /** Candidate base pitches in Hz. */
  f0: number[];
  /** Multiples of the base pitch that are checked. */
  harmonics: number;
  /** A multiple counts when its peak is this many dB above the spectrum beside it. */
  peakDb: number;
  /** Multiples that must stand out for a frame to count as ring-like. */
  minHarmonics: number;
  /** Fast path: this much ring-like sound within `fastWindowS`, plus one pulse gap. */
  fastOnS: number;
  fastWindowS: number;
  /** Depth in dB of the gap between bursts. */
  dipDb: number;
  /** Slow path, for rings half buried in noise where the gap is not visible. */
  slowOnS: number;
  slowWindowS: number;
  cooldownS: number;
}

export const defaultRingConfig: RingConfig = {
  f0: [390, 391, 392],
  harmonics: 10,
  peakDb: 10,
  minHarmonics: 4,
  fastOnS: 0.5,
  fastWindowS: 0.9,
  dipDb: 8,
  slowOnS: 1.6,
  slowWindowS: 2.2,
  cooldownS: 30,
};

export type RingEvent =
  | { type: "ring"; path: "fast" | "slow"; t: number }
  /** A stretch of ring-like sound has ended. Logged to see near misses and what else sets it off. */
  | { type: "activity"; t: number; ringS: number; maxHarmonics: number; fired: boolean };

interface Probe {
  /** First of the three bins searched for the peak. */
  lo: number;
}

function probes(f0: number, multiples: number[]): Probe[] {
  return multiples.map((m) => ({ lo: Math.round((m * f0) / BIN) - 1 }));
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci, xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr; im[b] = im[a]! - xi;
        re[a] = re[a]! + xr; im[a] = im[a]! + xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const HANN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

export class RingDetector {
  private buf = new Float64Array(N);
  private filled = 0;
  private frames = 0;
  private ring: boolean[] = [];
  private energy: number[] = [];
  private cooldown = 0;
  private re = new Float64Array(N);
  private im = new Float64Array(N);
  private power = new Float64Array(N / 2 + 1);
  private side = new Float64Array(14);
  private sets: { harm: Probe[]; half: Probe[]; third: Probe[] }[];
  // current stretch of ring-like sound, for the activity log
  private act: { frames: number; last: number; max: number; fired: boolean } | null = null;

  constructor(readonly cfg: RingConfig = defaultRingConfig) {
    const k = Array.from({ length: cfg.harmonics }, (_, i) => i + 1);
    const between = k.slice(0, -1);
    this.sets = cfg.f0.map((f0) => ({
      harm: probes(f0, k),
      // A note one octave or a twelfth below has partials on every multiple of the
      // ring's pitch too, but also in between. The ring has nothing in between.
      half: probes(f0, between.map((m) => m + 0.5)),
      third: probes(f0, between.flatMap((m) => [m + 1 / 3, m + 2 / 3])),
    }));
  }

  /** Feed mono samples in the range -1 to 1 (or any scale: only ratios matter). */
  push(samples: Float32Array | Float64Array | Int16Array): RingEvent[] {
    const out: RingEvent[] = [];
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.filled++] = samples[i]!;
      if (this.filled === N) {
        this.frame(out);
        this.buf.copyWithin(0, HOP);
        this.filled = N - HOP;
      }
    }
    return out;
  }

  /** Peak at a probe in dB above the median of the bins on either side of it. */
  private peak(p: Probe): { db: number; pk: number } {
    const P = this.power;
    const pk = Math.max(P[p.lo]!, P[p.lo + 1]!, P[p.lo + 2]!);
    for (let i = 0; i < 7; i++) {
      this.side[i] = P[p.lo - 9 + i]!;
      this.side[7 + i] = P[p.lo + 5 + i]!;
    }
    this.side.sort();
    const floor = (this.side[6]! + this.side[7]!) / 2 + 1e-20;
    return { db: 10 * Math.log10(pk / floor + 1e-20), pk };
  }

  private count(ps: Probe[]) {
    let n = 0;
    for (const p of ps) if (this.peak(p).db >= this.cfg.peakDb) n++;
    return n;
  }

  private frame(out: RingEvent[]) {
    const c = this.cfg;
    for (let i = 0; i < N; i++) {
      this.re[i] = this.buf[i]! * HANN[i]!;
      this.im[i] = 0;
    }
    fft(this.re, this.im);
    for (let i = 0; i <= N / 2; i++) this.power[i] = this.re[i]! ** 2 + this.im[i]! ** 2;

    let best = -1, bestE = 0, bestSet = this.sets[0]!;
    for (const s of this.sets) {
      let n = 0, e = 0;
      for (const p of s.harm) {
        const r = this.peak(p);
        if (r.db >= c.peakDb) n++;
        e += r.pk;
      }
      if (n > best) { best = n; bestE = e; bestSet = s; }
    }
    const isRing =
      best >= c.minHarmonics && this.count(bestSet.half) < 3 && this.count(bestSet.third) < 5;

    const keep = Math.round(c.slowWindowS / FRAME_S);
    this.ring.push(isRing);
    this.energy.push(10 * Math.log10(bestE + 1e-20));
    if (this.ring.length > keep) { this.ring.shift(); this.energy.shift(); }
    const t = (this.frames++ * HOP + N) / SAMPLE_RATE;

    let fired: "fast" | "slow" | null = null;
    if (this.cooldown > 0) this.cooldown--;
    else fired = this.decide();
    if (fired) {
      this.cooldown = Math.round(c.cooldownS / FRAME_S);
      out.push({ type: "ring", path: fired, t });
    }

    if (isRing) {
      this.act ??= { frames: 0, last: 0, max: 0, fired: false };
      this.act.frames++;
      this.act.last = this.frames;
      this.act.max = Math.max(this.act.max, best);
    }
    if (this.act) {
      if (fired) this.act.fired = true;
      if (this.frames - this.act.last > 1 / FRAME_S) {
        if (this.act.frames >= 19) // 0.3 s; shorter flickers are common and not worth a log line
          out.push({
            type: "activity",
            t,
            ringS: Math.round(this.act.frames * FRAME_S * 100) / 100,
            maxHarmonics: this.act.max,
            fired: this.act.fired,
          });
        this.act = null;
      }
    }
  }

  private decide(): "fast" | "slow" | null {
    const c = this.cfg;
    const ring = this.ring, e = this.energy, len = ring.length;

    const a = Math.max(0, len - Math.round(c.fastWindowS / FRAME_S));
    let on = 0;
    for (let i = a; i < len; i++) if (ring[i]) on++;
    if (on >= Math.round(c.fastOnS / FRAME_S)) {
      // Look for the gap between two bursts: a frame clearly quieter, on the ring's
      // own pitches, than ring-like frames shortly before and shortly after it.
      for (let j = a + 3; j < len - 3; j++) {
        let left = -Infinity, right = -Infinity;
        for (let i = Math.max(a, j - 12); i < j; i++) if (ring[i]) left = Math.max(left, e[i]!);
        for (let i = j + 1; i < Math.min(len, j + 13); i++) if (ring[i]) right = Math.max(right, e[i]!);
        if (e[j]! <= left - c.dipDb && e[j]! <= right - c.dipDb) return "fast";
      }
    }

    let slow = 0;
    for (let i = 0; i < len; i++) if (ring[i]) slow++;
    return slow >= Math.round(c.slowOnS / FRAME_S) ? "slow" : null;
  }
}
