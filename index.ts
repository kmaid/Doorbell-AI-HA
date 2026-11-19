import { spawn } from "node:child_process";
import fs from "node:fs";

import { AudioHistory, ClipStore, RollingRecorder, type ClipInfo } from "./src/clips";
import { RingMatcher, SAMPLE_RATE, defaultMatcherConfig } from "./src/matcher";
import { WasherListener, type WasherPair } from "./src/washer";

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

// AUDIO_CMD replaces the microphone with any command that writes raw signed 16-bit
// mono PCM at 16 kHz to stdout, for testing. The webhooks are not called then.
const testCmd = process.env["AUDIO_CMD"];
const cmd = testCmd
  ? ["sh", "-c", testCmd]
  : [
      "sox", "-t", "alsa", findMic(process.env["MIC_NAME"]), "-q",
      "-r", String(SAMPLE_RATE), "-c", "1", "-e", "signed-integer", "-b", "16", "-t", "raw", "-",
    ];

const webhook = async (id: string | undefined) => {
  if (testCmd) return;
  try {
    const res = await fetch(new URL(`/api/webhook/${id}`, process.env["HOMEASSISTANT_URL"]!), {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error(`Webhook failed with HTTP ${res.status}`);
  } catch (e) {
    console.error("Webhook failed:", e instanceof Error ? e.message : e);
  }
};
const ring = () => webhook(process.env["HOMEASSISTANT_INTERCOM_RING_WEBHOOK_ID"]);

const matcher = new RingMatcher({
  ...defaultMatcherConfig,
  margin: num("RING_MARGIN", defaultMatcherConfig.margin),
  cooldownS: num("RING_COOLDOWN_S", defaultMatcherConfig.cooldownS),
});

// With DATA_DIR set, every stretch of sound that the matcher or the washer listener reacts to is saved
// with some audio before and after it, fired or not, so misfires and near misses can
// be replayed.
const PRE_ROLL_S = 2;
// long enough for two pairs of washer beeps three periods apart
const history = new AudioHistory(SAMPLE_RATE, 60);
const startMs = Date.now();
const store = process.env["DATA_DIR"]
  ? new ClipStore(
      `${process.env["DATA_DIR"]}/clips`,
      num("CLIP_KEEP_DAYS", 30),
      num("CLIP_MAX_GB", 2) * 1024 ** 3
    )
  : null;
// All audio from the last while, for looking into a ring that left no trace at all.
const rollingMinutes = num("ROLLING_MINUTES", 60);
let rolling =
  process.env["DATA_DIR"] && rollingMinutes > 0
    ? new RollingRecorder(`${process.env["DATA_DIR"]}/rolling`, rollingMinutes)
    : null;

/** Saves the audio between two stream times (seconds) and returns the clip's name, or "". */
function saveClip(fromS: number, toS: number, info: Omit<ClipInfo, "startedAt" | "durationS">) {
  if (!store) return "";
  try {
    const pcm = history.slice(fromS - PRE_ROLL_S, toS);
    // Stream time is counted in samples, so place the clip by counting back from now.
    const from = toS - pcm.length / SAMPLE_RATE;
    const startedAt = testCmd
      ? startMs + from * 1000
      : Date.now() - (history.total / SAMPLE_RATE - from) * 1000;
    return "clip " + store.save(pcm, SAMPLE_RATE, { ...info, startedAt: new Date(startedAt).toISOString() });
  } catch (e) {
    console.error("Could not save clip:", e);
    return "";
  }
}

// ---- the washing machine -----------------------------------------------------------

// Listens for the washing machine's "finished" beep on the same audio. Without
// HOMEASSISTANT_WASHER_WEBHOOK_ID it only writes to the log and saves clips.
const washer = new WasherListener();
const washerWebhook = process.env["HOMEASSISTANT_WASHER_WEBHOOK_ID"];
const pairText = (p: WasherPair) =>
  `score ${p.score.toFixed(2)}, ${p.levelDb.toFixed(0)} dB above the sound beside it, ${p.pitchHz.toFixed(1)} Hz, pitch steady to ${p.wobbleHz.toFixed(1)} Hz`;
const pairInfo = (p: WasherPair) => ({
  score: Math.round(p.score * 1000) / 1000,
  levelDb: Math.round(p.levelDb * 10) / 10,
  pitchHz: Math.round(p.pitchHz * 100) / 100,
  wobbleHz: Math.round(p.wobbleHz * 100) / 100,
});

function onWasherAudio(samples: Int16Array) {
  for (const ev of washer.push(samples)) {
    if (ev.type === "pair") {
      const kind = ev.accepted ? "pair" : "near";
      const clip = saveClip(ev.startT, ev.t, { by: "washer", kind, fired: false, ...pairInfo(ev) });
      console.log(
        ev.accepted ? "Washer beep pair heard:" : "Washer-like beeps, not counted:",
        `${pairText(ev)},`,
        clip
      );
      continue;
    }
    const gapS = ev.second.startT - ev.first.startT;
    const clip = saveClip(ev.first.startT, ev.t, {
      by: "washer",
      kind: "finished",
      fired: true,
      gapS: Math.round(gapS * 100) / 100,
      pairs: [pairInfo(ev.first), pairInfo(ev.second)],
    });
    console.log(
      washerWebhook ? "Washing machine finished..." : "Washing machine finished (not sent, no webhook set):",
      `two beep pairs ${gapS.toFixed(2)} s apart, scores ${ev.first.score.toFixed(2)} and ${ev.second.score.toFixed(2)}, ${ev.second.pitchHz.toFixed(1)} Hz,`,
      clip
    );
    if (washerWebhook) void webhook(washerWebhook);
  }
}

// ---- the matcher -------------------------------------------------------------------

function onAudio(samples: Int16Array) {
  history.push(samples);
  try {
    rolling?.write(samples);
  } catch (e) {
    console.error("Rolling recording stopped:", e);
    rolling = null;
  }
  onWasherAudio(samples);
  for (const ev of matcher.push(samples)) {
    if (ev.type === "ring") {
      const detail = `${ev.windowS.toFixed(2)} s window, score ${ev.score.toFixed(2)}, fires at ${ev.threshold.toFixed(2)}, ${ev.partials} of 11 partials`;
      console.log(`Ringing... (${detail})`);
      void ring();
      continue;
    }
    const clip = saveClip(ev.startT, ev.t, { by: "matcher", fired: ev.fired, score: ev.score, windowS: ev.windowS, margin: ev.margin });
    console.log(
      `Matcher heard ring-like sound: score ${ev.score.toFixed(2)} over ${ev.windowS.toFixed(2)} s,`,
      `${Math.abs(ev.margin).toFixed(2)} ${ev.margin >= 0 ? "above" : "below"} firing,`,
      ev.fired ? "fired" : ev.margin >= 0 ? "not fired (cooldown)" : "not fired",
      clip
    );
  }
}

console.log(
  `Starting the ring detector: fires ${matcher.cfg.margin} above its ceilings, cooldown ${matcher.cfg.cooldownS}s`
);
console.log(
  "Listening for the washing machine's finish beep,",
  washerWebhook ? "which is sent to Home Assistant" : "log only (HOMEASSISTANT_WASHER_WEBHOOK_ID not set)"
);
console.log(
  store
    ? `Saving clips under ${store.dir}, and the last ${rolling ? rollingMinutes : 0} minutes of audio`
    : "Clip saving is off (DATA_DIR not set)"
);
if (store) {
  const prune = () => {
    try {
      const n = store.prune();
      if (n) console.log(`Removed ${n} old clip files`);
    } catch (e) {
      console.error("Could not prune clips:", e);
    }
  };
  prune();
  setInterval(prune, 3600000);
}

// ---- audio -------------------------------------------------------------------------

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
  onAudio(samples);
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
