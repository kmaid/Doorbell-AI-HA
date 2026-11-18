import { spawn } from "node:child_process";
import fs from "node:fs";

import { RingDetector, SAMPLE_RATE, defaultRingConfig } from "./src/ring";

const fail = (...msg: unknown[]) => {
  console.error(...msg);
  process.exit(1);
};

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return process.env[name] && Number.isFinite(v) ? v : fallback;
};

/** ALSA device id for the sound card with the given name. */
function findMic(name: string | undefined): string {
  const cards = fs
    .readFileSync("/proc/asound/cards", "utf8")
    .split("\n")
    .map((l) => l.trim().match(/^(\d+) .*?\]: (.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ id: `hw:${m[1]},0`, name: m[2]! }));
  const card = cards.find((c) => c.name === name);
  if (!card) {
    fail(`Invalid microphone name (${name}), found: ` + cards.map((c) => `"${c.name}"`).join(", "));
  }
  return card!.id;
}

const detector = new RingDetector({
  ...defaultRingConfig,
  minHarmonics: num("RING_MIN_HARMONICS", defaultRingConfig.minHarmonics),
  cooldownS: num("RING_COOLDOWN_S", defaultRingConfig.cooldownS),
});

const ring = async () => {
  try {
    const res = await fetch(
      new URL(
        `/api/webhook/${process.env["HOMEASSISTANT_INTERCOM_RING_WEBHOOK_ID"]}`,
        process.env["HOMEASSISTANT_URL"]!
      ),
      { method: "GET", signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) console.error(`Webhook failed with HTTP ${res.status}`);
  } catch (e) {
    console.error("Webhook failed:", e instanceof Error ? e.message : e);
  }
};

// AUDIO_CMD replaces the microphone with any command that writes raw 16 kHz
// signed 16-bit mono PCM to stdout, for testing. The webhook is not called then.
const testCmd = process.env["AUDIO_CMD"];
const cmd = testCmd
  ? ["sh", "-c", testCmd]
  : [
      "sox", "-t", "alsa", findMic(process.env["MIC_NAME"]), "-q",
      "-r", String(SAMPLE_RATE), "-c", "1", "-e", "signed-integer", "-b", "16", "-t", "raw", "-",
    ];

console.log(
  `Starting the ring detector: base pitch ${detector.cfg.f0.join("/")} Hz,`,
  `${detector.cfg.minHarmonics} of ${detector.cfg.harmonics} multiples, cooldown ${detector.cfg.cooldownS}s`
);

const cp = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
let odd: Buffer | null = null;
let lastAudio = Date.now();
let level = 0;

cp.stdout.on("data", (chunk: Buffer) => {
  lastAudio = Date.now();
  if (odd) {
    chunk = Buffer.concat([odd, chunk]);
    odd = null;
  }
  if (chunk.length & 1) {
    odd = chunk.subarray(chunk.length - 1);
    chunk = chunk.subarray(0, chunk.length - 1);
  }
  // Copy into an aligned array: a pipe chunk may start at an odd byte offset.
  const samples = new Int16Array(chunk.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = chunk.readInt16LE(i * 2);
    level = Math.max(level, Math.abs(samples[i]!));
  }
  for (const ev of detector.push(samples)) {
    if (ev.type === "ring") {
      console.log(`Ringing... (${ev.path})`);
      if (!testCmd) void ring();
    } else {
      console.log(
        `Ring-like sound for ${ev.ringS}s, up to ${ev.maxHarmonics} multiples,`,
        ev.fired ? "fired" : "not fired"
      );
    }
  }
});
cp.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
cp.on("error", (e) => fail("Could not start audio capture:", e.message));
cp.on("close", (code) => {
  if (testCmd && code === 0) process.exit(0);
  fail(`Audio capture stopped (code ${code}): ${stderr}`);
});

if (!testCmd) {
  setInterval(() => {
    if (Date.now() - lastAudio > 10000) fail("No audio for 10 seconds");
  }, 2000);
  // A flat signal means the microphone is not really delivering sound.
  setTimeout(() => {
    if (level < 20) fail("Microphone signal is flat");
  }, 15000);
}
