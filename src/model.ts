/**
 * The Edge Impulse model the listener used until 2026-11-18, and its firing rule.
 * It is the detector with a track record in this flat, so it runs beside the
 * matcher as the yardstick. It wants 32 kHz audio in slices of half a second and
 * answers with a ring score between 0 and 1 for the last two seconds.
 */
import { LinuxImpulseRunner } from "edge-impulse-linux";

export const MODEL_RATE = 32000;
export const MODEL_FILE = "model/kmaid-project-1-linux-x86_64-v22.eim";
const SLICE = 16000;

/**
 * The old listener's rule: the first score above 0.95 opens a count that lasts
 * 60 seconds, and the fifth score above 0.95 within it rings. Nothing more can
 * ring until those 60 seconds are over.
 */
export class ModelRule {
  count = 0;
  private opened = -Infinity;

  constructor(readonly score = 0.95, readonly needed = 5, readonly windowS = 60) {}

  /** `t` is the time of the result in seconds. Returns true when this result rings. */
  feed(score: number, t: number): boolean {
    if (t - this.opened >= this.windowS) this.count = 0;
    if (score <= this.score) return false;
    if (this.count === 0) this.opened = t;
    return ++this.count === this.needed;
  }
}

export class RingModel {
  private runner = new LinuxImpulseRunner(MODEL_FILE);
  private slice = new Int16Array(SLICE);
  private filled = 0;
  private total = 0;
  private queue: Promise<void> = Promise.resolve();
  private waiting = 0;

  /** Called with every score, in order, and the stream time in seconds at which its slice ended. */
  constructor(private onScore: (score: number, t: number) => void, private onError: (e: unknown) => void) {}

  async init() {
    const info = await this.runner.init();
    if (info.modelParameters.frequency !== MODEL_RATE) throw new Error("The model does not take 32 kHz audio");
  }

  /** Feed 32 kHz samples. Classification runs in the model's own process, one slice at a time. */
  push(samples: Int16Array) {
    for (let i = 0; i < samples.length; i++) {
      this.slice[this.filled++] = samples[i]!;
      this.total++;
      if (this.filled < SLICE) continue;
      this.filled = 0;
      const data = Array.from(this.slice), t = this.total / MODEL_RATE;
      // If the model falls far behind (20 seconds), drop slices instead of letting audio pile up.
      if (this.waiting >= 40) continue;
      this.waiting++;
      this.queue = this.queue
        .then(() => this.runner.classifyContinuous(data))
        .then((res) => this.onScore(res.result.classification?.["ring"] ?? 0, t))
        .catch(this.onError)
        .finally(() => void this.waiting--);
    }
  }

  /** Slices waiting to be scored. */
  get backlog() {
    return this.waiting;
  }

  /** Resolves when every slice pushed so far has been scored. */
  idle() {
    return this.queue;
  }

  async stop() {
    await this.queue;
    await this.runner.stop();
  }
}
