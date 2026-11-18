/**
 * Halves the sample rate of a stream (32 kHz from the microphone to the 16 kHz the
 * matcher works at). A 63-tap low-pass at 7.5 kHz comes first, so that nothing
 * above 8 kHz folds back down.
 */
const TAPS = 63;
const H = new Float64Array(TAPS);
{
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const k = i - (TAPS - 1) / 2, x = 2 * Math.PI * (7500 / 32000) * k;
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1));
    H[i] = (k === 0 ? 1 : Math.sin(x) / x) * blackman;
    sum += H[i]!;
  }
  for (let i = 0; i < TAPS; i++) H[i]! /= sum;
}

export class Halver {
  private hist = new Float64Array(TAPS);
  private at = 0;
  private odd = false;

  push(samples: Int16Array): Int16Array {
    const out = new Int16Array((samples.length + (this.odd ? 1 : 0)) >> 1);
    let n = 0;
    for (let i = 0; i < samples.length; i++) {
      this.hist[this.at] = samples[i]!;
      this.at = (this.at + 1) % TAPS;
      this.odd = !this.odd;
      if (this.odd) continue;
      let acc = 0;
      for (let k = 0, j = this.at; k < TAPS; k++, j = j + 1 === TAPS ? 0 : j + 1) acc += H[k]! * this.hist[j]!;
      out[n++] = Math.max(-32768, Math.min(32767, Math.round(acc)));
    }
    return out;
  }
}
