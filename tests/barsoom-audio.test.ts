import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  flightAudioTargets,
  landingAudioTargets,
  suitThrusterAudioTarget,
} from "../app/audio/BarsoomAudio";

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
    "suit-land.mp3",
  ])("ships the generated ElevenLabs asset %s", async (filename) => {
    const audio = await readFile(path.join(process.cwd(), "public", "audio", filename));
    expect(audio.byteLength).toBeGreaterThan(10_000);
    expect(audio.subarray(0, 3).toString("ascii")).toMatch(/ID3|\xFF/);
  });

  it("keeps the layered touchdown impact clearly audible during narration", () => {
    const normal = landingAudioTargets(false);
    const narrated = landingAudioTargets(true);
    expect(normal.impactVolume).toBeGreaterThan(0.9);
    expect(normal.suitContactVolume).toBeGreaterThan(0.3);
    expect(narrated.impactVolume).toBeGreaterThan(0.65);
    expect(narrated.suitContactVolume).toBeGreaterThan(0.2);
  });

  it("runs an audible suit-thruster loop only while maneuvering", () => {
    expect(suitThrusterAudioTarget(false, false)).toBe(0);
    expect(suitThrusterAudioTarget(true, false)).toBeGreaterThan(0.4);
    expect(suitThrusterAudioTarget(true, true)).toBeGreaterThan(0.24);
  });
});
