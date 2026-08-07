import { readFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  SurfaceSpaceship,
  SURFACE_SPACESHIP_MODEL_PATH,
  spaceshipSteerAmount,
  type SpaceshipFlightInput,
} from "../app/planet/SurfaceSpaceship";

const neutralFlightInput: SpaceshipFlightInput = {
  throttle: 0,
  strafe: 0,
  lift: 0,
  roll: 0,
  boost: false,
  aimX: 0,
  aimY: 0,
};

describe("surface spaceship flight", () => {
  it("ships the compact decoder-free Quaternius Ultimate Space Kit model", async () => {
    const filename = SURFACE_SPACESHIP_MODEL_PATH.split("/").at(-1);
    expect(filename).toBeTruthy();
    const file = await readFile(path.join(process.cwd(), "public", "models", filename!));
    const jsonLength = file.readUInt32LE(12);
    const document = JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8").trimEnd()) as {
      extensionsUsed?: string[];
      nodes?: Array<{ name?: string }>;
    };

    expect(file.byteLength).toBeLessThan(150_000);
    expect(document.extensionsUsed ?? []).not.toContain("KHR_draco_mesh_compression");
    expect(document.nodes?.some((node) => node.name === "Spaceship_RaeTheRedPanda")).toBe(true);
  });

  it("uses a centred mouse dead zone and progressively stronger edge steering", () => {
    expect(spaceshipSteerAmount(0)).toBe(0);
    expect(spaceshipSteerAmount(0.04)).toBe(0);
    expect(spaceshipSteerAmount(-0.04)).toBe(0);
    expect(spaceshipSteerAmount(0.5)).toBeGreaterThan(0);
    expect(spaceshipSteerAmount(-0.5)).toBeCloseTo(-spaceshipSteerAmount(0.5), 12);
    expect(spaceshipSteerAmount(1)).toBe(1);
  });

  it("integrates thrust from real delta seconds without an ephemeris-rate input", () => {
    const scene = new THREE.Scene();
    const craft = new SurfaceSpaceship(
      scene,
      () => ({ heightM: 0, normal: { x: 1, y: 0, z: 0 }, lod: 16 }),
      () => undefined,
    );
    craft.spawnNear(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, -1, 0),
    );
    craft.board();
    for (let frame = 0; frame < 60; frame += 1) {
      craft.updateFlight(1 / 60, { ...neutralFlightInput, throttle: 1 });
    }

    expect(craft.getSpeedMps()).toBeGreaterThan(45);
    expect(craft.getSpeedMps()).toBeLessThan(70);
    craft.dispose();
  });
});
