import {
  AudioClassifier,
  AudioRecorder,
  LinuxImpulseRunner,
} from "edge-impulse-linux";

import "dotenv/config";

let rings = 0;
const RING_THRESHOLD = 3;

// tslint:disable-next-line: no-floating-promises
(async () => {
  try {
    let runner = new LinuxImpulseRunner(
      "model/kmaid-project-1-linux-x86_64-v22.eim"
    );
    let model = await runner.init();

    const windowLengthMs =
      (model.modelParameters.input_features_count /
        model.modelParameters.frequency /
        model.modelParameters.axis_count) *
      1000;

    console.log(
      "Starting the audio classifier for",
      model.project.owner + " / " + model.project.name,
      "(v" + model.project.deploy_version + ")"
    );
    console.log(
      "Parameters",
      "freq",
      model.modelParameters.frequency + "Hz",
      "window length",
      windowLengthMs + "ms.",
      "classes",
      model.modelParameters.labels
    );

    // Find the right microphone to run this model with (can be passed in as argument to the script)
    let devices = await AudioRecorder.ListDevices();
    if (devices.length === 0) {
      devices = [{ id: "", name: "Default microphone" }];
    }
    let device;
    let d = devices.find((x) => x.id === process.env.MIC_HW_ID);
    if (!d) {
      throw new Error(
        `Invalid microphone id (${process.env.MIC_HW_ID}), found: ${devices
          .map((n) => '"' + n.name + '"')
          .join(", ")}`
      );
    }
    device = d.id;

    let audioClassifier = new AudioClassifier(runner, false /* verbose */);

    audioClassifier.on("noAudioError", async () => {
      console.log("");
      console.log(
        "ERR: Did not receive any audio. Here are some potential causes:"
      );
      console.log("* If you are on macOS this might be a permissions issue.");
      console.log(
        "  Are you running this command from a simulated shell (like in Visual Studio Code)?"
      );
      console.log(
        "* If you are on Linux and use a microphone in a webcam, you might also want"
      );
      console.log("  to initialize the camera (see camera.js)");
      await audioClassifier?.stop();
      process.exit(1);
    });

    await audioClassifier.start(device);
    // when new data comes in, this handler is called.
    // Use it to draw conclusions, send interesting events to the cloud etc.
    audioClassifier.on("result", async (ev, _, __) => {
      if (!ev.result.classification) return;

      // print the raw predicted values for this frame
      // (turn into string here so the content does not jump around)
      // tslint:disable-next-line: no-unsafe-any
      let c = <{ [k: string]: string | number }>(<any>ev.result.classification);
      for (let k of Object.keys(c)) {
        c[k] = (<number>c[k]).toFixed(4);
      }
      if ((c["ring"] as number) > 0.2) {
        console.log(`Rings:${rings}/${RING_THRESHOLD} Score:${c["ring"]}`);
      }
      if ((c["ring"] as number) > 0.9) {
        await ringDetected();
      }
    });
  } catch (ex) {
    console.error(ex);
    process.exit(1);
  }
})();

const ringDetected = async () => {
  rings++;
  if (rings === 1) {
    console.log(`Debounce started ${rings}`);
    setTimeout(() => {
      rings = 0;
      console.log("Debounce finished");
    }, 1000 * 15);
  } else if (rings === RING_THRESHOLD) {
    try {
      console.log("Ringing...");
      await fetch(
        new URL(
          `/api/webhook/${process.env["HOMEASSISTANT_INTERCOM_RING_WEBHOOK_ID"]}`,
          process.env["HOMEASSISTANT_URL"]!
        ).toString(),
        {
          method: "GET",
        }
      );
    } catch (e) {
      console.error(e);
    }
  }
};
