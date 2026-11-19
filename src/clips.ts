import fs from "node:fs";
import path from "node:path";

export interface ClipInfo {
  startedAt: string;
  durationS: number;
  /** Which detector the clip was saved for. */
  by: "matcher" | "washer";
  /** Washer: "finished", "pair" (one pair that counts) or "near" (one that fell short). Names the file when set. */
  kind?: string;
  /** Whether it rang the intercom webhook, or for the washer, whether the machine was judged finished. */
  fired: boolean;
  /** Matcher: best score, the window it was scored over, and its distance from firing. */
  score?: number;
  windowS?: number;
  margin?: number;
  /** Washer: the tone's strength, pitch and steadiness; for "finished", both pairs and the time between them. */
  levelDb?: number;
  pitchHz?: number;
  wobbleHz?: number;
  gapS?: number;
  pairs?: unknown[];
}

export function wav(pcm: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Reads a 16-bit mono PCM wav file. */
export function readWav(file: string): { pcm: Int16Array; sampleRate: number } {
  const b = fs.readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.readUInt16LE(22) !== 1 || b.readUInt16LE(34) !== 16) {
    throw new Error(`${file}: expected a 16-bit mono wav`);
  }
  let at = 12;
  while (b.toString("ascii", at, at + 4) !== "data") at += 8 + b.readUInt32LE(at + 4);
  const len = Math.min(b.readUInt32LE(at + 4), b.length - at - 8) >> 1;
  const pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) pcm[i] = b.readInt16LE(at + 8 + i * 2);
  return { pcm, sampleRate: b.readUInt32LE(24) };
}

/** The most recent audio, so a clip can include what came before a detection. */
export class AudioHistory {
  private buf: Int16Array;
  /** Samples seen since the start of the stream. */
  total = 0;

  constructor(readonly sampleRate: number, seconds: number) {
    this.buf = new Int16Array(Math.round(sampleRate * seconds));
  }

  push(samples: Int16Array) {
    for (let i = 0; i < samples.length; i++) this.buf[this.total++ % this.buf.length] = samples[i]!;
  }

  /** Audio between two stream times in seconds, cut to what is still held. */
  slice(fromS: number, toS: number): Int16Array {
    const to = Math.min(this.total, Math.round(toS * this.sampleRate));
    const from = Math.max(0, this.total - this.buf.length, Math.round(fromS * this.sampleRate));
    const out = new Int16Array(Math.max(0, to - from));
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(from + i) % this.buf.length]!;
    return out;
  }
}

/**
 * Clips live in <dir>/YYYY-MM-DD/<time>-matcher-<fired|near>.wav, or
 * <time>-washer-<finished|pair|near>.wav, with a .json beside each.
 * Old clips are removed by age, then oldest first while over the size limit.
 */
export class ClipStore {
  constructor(readonly dir: string, readonly keepDays = 30, readonly maxBytes = 2 * 1024 ** 3) {}

  save(pcm: Int16Array, sampleRate: number, info: Omit<ClipInfo, "durationS">): string {
    const stamp = info.startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const base = path.join(this.dir, info.startedAt.slice(0, 10), `${stamp}-${info.by}-${info.kind ?? (info.fired ? "fired" : "near")}`);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(`${base}.wav`, wav(pcm, sampleRate));
    const full: ClipInfo = { ...info, durationS: Math.round((pcm.length / sampleRate) * 100) / 100 };
    fs.writeFileSync(`${base}.json`, JSON.stringify(full));
    return path.basename(base);
  }

  prune(now = Date.now()): number {
    if (!fs.existsSync(this.dir)) return 0;
    const files: { file: string; size: number; day: string }[] = [];
    for (const day of fs.readdirSync(this.dir).sort()) {
      const d = path.join(this.dir, day);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d).sort()) {
        files.push({ file: path.join(d, f), size: fs.statSync(path.join(d, f)).size, day });
      }
    }
    let total = files.reduce((a, f) => a + f.size, 0);
    let removed = 0;
    for (const f of files) {
      const ageDays = (now - Date.parse(`${f.day}T00:00:00Z`)) / 86400000;
      if (ageDays <= this.keepDays + 1 && total <= this.maxBytes) continue;
      fs.rmSync(f.file, { force: true });
      total -= f.size;
      removed++;
    }
    for (const day of fs.readdirSync(this.dir)) {
      const d = path.join(this.dir, day);
      if (fs.statSync(d).isDirectory() && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    }
    return removed;
  }
}

/**
 * Keeps the last stretch of raw audio on disk as one-minute files named by
 * their UTC start time (<dir>/YYYYMMDDTHHMMSSZ.raw, 16-bit mono PCM), so a ring
 * the detector missed completely can still be found afterwards.
 */
export class RollingRecorder {
  private fd: number | null = null;
  private minute = -1;

  constructor(readonly dir: string, readonly keepMinutes: number) {
    fs.mkdirSync(dir, { recursive: true });
  }

  write(samples: Int16Array, now = Date.now()) {
    const minute = Math.floor(now / 60000);
    if (minute !== this.minute) {
      if (this.fd !== null) fs.closeSync(this.fd);
      const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      this.fd = fs.openSync(path.join(this.dir, `${stamp}.raw`), "a");
      this.minute = minute;
      this.prune(now);
    }
    fs.writeSync(this.fd!, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  private prune(now: number) {
    for (const f of fs.readdirSync(this.dir)) {
      const m = f.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z\.raw$/);
      if (!m) continue;
      const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
      // a file covers up to a minute after its name
      if (now - t > (this.keepMinutes + 1) * 60000) fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }
}
