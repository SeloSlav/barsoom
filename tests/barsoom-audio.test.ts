import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flightAudioTargets } from "../app/audio/BarsoomAudio";

describe("spacecraft audio", () => {
  it("crossfades from an audible flight engine into the booster layer", () => {
    expect(flightAudioTargets({ active: false, throttle: 1, boost: true })).toEqual({
      engine: 0,
      booster: 0,
    });
    const cruise = flightAudioTargets({ active: true, throttle: 0.5, boost: false });
    const boosted = flightAudioTargets({ active: true, throttle: 1, boost: true });

    expect(cruise.engine).toBeGreaterThan(0.05);
    expect(cruise.booster).toBe(0);
    expect(boosted.engine).toBeGreaterThan(cruise.engine);
    expect(boosted.booster).toBeGreaterThan(boosted.engine);
  });

  it.each([
    "spacecraft-engine-loop.mp3",
    "spacecraft-boost-loop.mp3",
    "spacecraft-boost-ignite.mp3",
    "spacecraft-thruster-burst.mp3",
  ])("ships the generated ElevenLabs asset %s", async (filename) => {
    const audio = await readFile(path.join(process.cwd(), "public", "audio", filename));
    expect(audio.byteLength).toBeGreaterThan(10_000);
    expect(audio.subarray(0, 3).toString("ascii")).toMatch(/ID3|\xFF/);
  });
});
