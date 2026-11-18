import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AudioHistory, ClipStore, RollingRecorder, readWav, wav } from "../src/clips";

test("history returns the requested stretch, cut to what it still holds", () => {
  const h = new AudioHistory(10, 5); // 10 samples a second, 5 seconds
  h.push(Int16Array.from({ length: 80 }, (_, i) => i));
  expect([...h.slice(4, 4.5)]).toEqual([40, 41, 42, 43, 44]);
  // the first 3 seconds have been overwritten, and nothing exists after 8 s
  expect(h.slice(0, 100).length).toBe(50);
  expect(h.slice(0, 100)[0]).toBe(30);
  expect(h.slice(-2, 3.5).length).toBe(5);
});

test("clips are written as wav with details, and pruned by age and size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clips-"));
  const store = new ClipStore(dir, 30, 1e9);
  const pcm = Int16Array.from({ length: 16000 }, (_, i) => (i % 200) - 100);
  const info = { by: "matcher" as const, score: 0.9, windowS: 0.53, margin: 0.27 };
  const a = store.save(pcm, 16000, { ...info, startedAt: "2026-01-01T10:00:00.000Z", fired: true });
  const b = store.save(pcm, 16000, { ...info, startedAt: "2026-02-20T10:00:00.000Z", fired: false });
  expect(a).toBe("20260101T100000Z-matcher-fired");
  expect(b).toBe("20260220T100000Z-matcher-near");
  const back = readWav(path.join(dir, "2026-01-01", `${a}.wav`));
  expect(back.sampleRate).toBe(16000);
  expect([...back.pcm.slice(0, 5)]).toEqual([...pcm.slice(0, 5)]);
  expect(JSON.parse(fs.readFileSync(path.join(dir, "2026-02-20", `${b}.json`), "utf8")).durationS).toBe(1);

  // 1 March: the January clip is over 30 days old, the February one is not
  expect(store.prune(Date.parse("2026-03-01T00:00:00Z"))).toBe(2);
  expect(fs.readdirSync(dir)).toEqual(["2026-02-20"]);
  // a tiny size limit removes the rest
  expect(new ClipStore(dir, 30, 10).prune(Date.parse("2026-03-01T00:00:00Z"))).toBe(2);
  expect(fs.readdirSync(dir)).toEqual([]);
  expect(wav(pcm, 16000).length).toBe(44 + 32000);
  fs.rmSync(dir, { recursive: true });
});

test("rolling recording keeps one file a minute and drops old ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-"));
  const r = new RollingRecorder(dir, 3);
  const t0 = Date.parse("2026-01-01T10:00:20Z");
  const chunk = new Int16Array(100).fill(7);
  // ten minutes of audio, a chunk every 20 seconds
  for (let s = 0; s < 600; s += 20) r.write(chunk, t0 + s * 1000);
  const files = fs.readdirSync(dir).sort();
  // files older than 3 minutes (plus the minute a file spans) are gone
  expect(files).toEqual([
    "20260101T100600Z.raw",
    "20260101T100700Z.raw",
    "20260101T100800Z.raw",
    "20260101T100900Z.raw",
    "20260101T101000Z.raw",
  ]);
  expect(fs.statSync(path.join(dir, files[0]!)).size).toBe(3 * 200);
  fs.rmSync(dir, { recursive: true });
});
