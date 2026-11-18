import { expect, test } from "bun:test";

import { ModelRule } from "../src/model";
import { Halver } from "../src/resample";

test("the model rings on the fifth score above 0.95 within 60 seconds", () => {
  const r = new ModelRule();
  const rang = [0.99, 0.5, 0.96, 0.95, 1, 0.97, 0.99, 1].map((s, i) => r.feed(s, 10 + i * 0.5));
  // 0.5 and 0.95 do not count, so the fifth that does is the seventh result
  expect(rang).toEqual([false, false, false, false, false, false, true, false]);
});

test("nothing more rings until 60 seconds after the first high score, then the count starts again", () => {
  const r = new ModelRule();
  for (let i = 0; i < 5; i++) r.feed(1, i * 0.5);
  for (let t = 3; t < 59; t += 0.5) expect(r.feed(1, t)).toBe(false);
  const rang = [60, 60.5, 61, 61.5, 62].map((t) => r.feed(1, t));
  expect(rang).toEqual([false, false, false, false, true]);
});

test("scattered high scores more than 60 seconds apart never ring", () => {
  const r = new ModelRule();
  for (let i = 0; i < 20; i++) expect(r.feed(1, i * 61)).toBe(false);
});

test("halving the sample rate keeps a tone below 7 kHz and removes one above 9 kHz", () => {
  const rms = (x: Int16Array) => Math.sqrt(x.slice(200).reduce((a, v) => a + v * v, 0) / (x.length - 200));
  const tone = (f: number) => Int16Array.from({ length: 32000 }, (_, i) => Math.round(10000 * Math.sin((2 * Math.PI * f * i) / 32000)));
  const halve = (x: Int16Array) => {
    // in uneven chunks, some of odd length
    const h = new Halver(), parts: number[] = [];
    for (let i = 0; i < x.length; i += 777) parts.push(...h.push(x.subarray(i, i + 777)));
    return Int16Array.from(parts);
  };
  expect(halve(tone(1000)).length).toBe(16000);
  for (const f of [391, 2344, 3906, 6500]) expect(rms(halve(tone(f))) / rms(tone(f))).toBeCloseTo(1, 1);
  for (const f of [9000, 12000, 15000]) expect(rms(halve(tone(f))) / rms(tone(f))).toBeLessThan(0.01);
});
