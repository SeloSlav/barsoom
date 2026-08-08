import { readFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { MARS_REFERENCE_RADIUS_M } from "../app/planet/constants";
import {
  SurfaceSpaceship,
  SHIP_AUTOPILOT_WARP_SPEED_M_S,
  SHIP_WARP_BURST_DELTA_V_M_S,
  SURFACE_SPACESHIP_MODEL_PATH,
  spaceshipDampedInput,
  spaceshipDirectionalSteer,
  spaceshipPlumeAnimation,
  spaceshipSteerAmount,
  spaceshipTrailStyle,
  type SpaceshipFlightInput,
} from "../app/planet/SurfaceSpaceship";

const neutralFlightInput: SpaceshipFlightInput = {
  throttle: 0,
  strafe: 0,
  lift: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  boost: false,
  brake: false,
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
    expect(spaceshipDirectionalSteer(-1, 1)).toBe(1);
    expect(spaceshipDirectionalSteer(1, -1)).toBe(-1);
  });

  it("damps control changes without undershoot or one-frame snapping", () => {
    const firstFrame = spaceshipDampedInput(0, 1, 16, 1 / 60);
    expect(firstFrame).toBeGreaterThan(0);
    expect(firstFrame).toBeLessThan(1);
    expect(spaceshipDampedInput(firstFrame, 1, 16, 1 / 60)).toBeGreaterThan(firstFrame);
    expect(spaceshipDampedInput(1, 0, 16, 1 / 60)).toBeGreaterThan(0);
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

    expect(craft.getSpeedMps()).toBeGreaterThan(68);
    expect(craft.getSpeedMps()).toBeLessThan(82);
    craft.dispose();
  });

  it("supports decisive keyboard yaw and vertical planetary thrust", () => {
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
    const initialForward = craft.getForward(new THREE.Vector3()).clone();
    const chaseViewRight = craft.getRight(new THREE.Vector3()).negate();
    const initialRadiusM = craft.getAbsolute(new THREE.Vector3()).length();
    for (let frame = 0; frame < 60; frame += 1) {
      craft.updateFlight(1 / 60, { ...neutralFlightInput, yaw: 1, lift: 1 });
    }

    const turnedForward = craft.getForward(new THREE.Vector3());
    expect(turnedForward.dot(initialForward)).toBeLessThan(0.1);
    expect(turnedForward.dot(chaseViewRight)).toBeGreaterThan(0.9);
    expect(craft.getAbsolute(new THREE.Vector3()).length()).toBeGreaterThan(initialRadiusM + 25);
    craft.dispose();
  });

  it("turns smoothly toward camera aim without snapping laterally", () => {
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
    const cameraDirection = new THREE.Vector3(0, -1, 0);
    const initialNose = craft.getForward(new THREE.Vector3()).clone();
    for (let frame = 0; frame < 30; frame += 1) {
      craft.updateFlight(1 / 60, {
        ...neutralFlightInput,
        aimDirection: cameraDirection,
      });
    }
    expect(craft.getForward(new THREE.Vector3()).dot(initialNose)).toBeGreaterThan(0.92);
    for (let frame = 0; frame < 270; frame += 1) {
      craft.updateFlight(1 / 60, {
        ...neutralFlightInput,
        aimDirection: cameraDirection,
      });
    }

    const alignedNose = craft.getForward(new THREE.Vector3()).clone();
    expect(alignedNose.dot(cameraDirection)).toBeGreaterThan(0.9999);
    for (let frame = 0; frame < 60; frame += 1) {
      craft.updateFlight(1 / 60, { ...neutralFlightInput, aimDirection: cameraDirection });
    }
    expect(craft.getForward(new THREE.Vector3()).distanceTo(alignedNose)).toBeLessThan(0.001);
    craft.dispose();
  });

  it("keeps existing momentum in world space while the hull turns", () => {
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
    const oldCourse = craft.getVelocity(new THREE.Vector3()).normalize().clone();
    for (let frame = 0; frame < 30; frame += 1) {
      craft.updateFlight(1 / 60, { ...neutralFlightInput, yaw: 1 });
    }

    const velocityDirection = craft.getVelocity(new THREE.Vector3()).normalize();
    const hullDirection = craft.getForward(new THREE.Vector3());
    expect(velocityDirection.dot(oldCourse)).toBeGreaterThan(0.999);
    expect(velocityDirection.dot(hullDirection)).toBeLessThan(0.7);
    craft.dispose();
  });

  it("points the nose upward and carries forward flight upward with pitch input", () => {
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
    const initialRadiusM = craft.getAbsolute(new THREE.Vector3()).length();
    for (let frame = 0; frame < 60; frame += 1) {
      craft.updateFlight(1 / 60, { ...neutralFlightInput, pitch: 1 });
    }
    craft.updateFlight(1 / 60, { ...neutralFlightInput, throttle: 1 });
    for (let frame = 0; frame < 60; frame += 1) {
      craft.updateFlight(1 / 60, neutralFlightInput);
    }

    const radialUp = craft.getAbsolute(new THREE.Vector3()).normalize();
    const nose = craft.getForward(new THREE.Vector3());
    const flightDirection = craft.getVelocity(new THREE.Vector3()).normalize();
    expect(nose.dot(radialUp)).toBeGreaterThan(0.99);
    expect(flightDirection.dot(nose)).toBeGreaterThan(0.995);
    expect(craft.getVelocity(new THREE.Vector3()).dot(radialUp)).toBeGreaterThan(0.8);
    expect(craft.getAbsolute(new THREE.Vector3()).length()).toBeGreaterThan(initialRadiusM + 0.5);
    craft.dispose();
  });

  it("maps Q to a visible left roll and E to a visible right roll", () => {
    const scene = new THREE.Scene();
    const makeCraft = () => {
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
      return craft;
    };
    const qCraft = makeCraft();
    const qVisualLeft = qCraft.getRight(new THREE.Vector3());
    for (let frame = 0; frame < 5; frame += 1) {
      qCraft.updateFlight(0.05, { ...neutralFlightInput, roll: -1 });
    }
    expect(qCraft.getUp(new THREE.Vector3()).dot(qVisualLeft)).toBeGreaterThan(0.4);

    const eCraft = makeCraft();
    const eVisualLeft = eCraft.getRight(new THREE.Vector3());
    for (let frame = 0; frame < 5; frame += 1) {
      eCraft.updateFlight(0.05, { ...neutralFlightInput, roll: 1 });
    }
    expect(eCraft.getUp(new THREE.Vector3()).dot(eVisualLeft)).toBeLessThan(-0.4);
    qCraft.dispose();
    eCraft.dispose();
  });

  it("coasts naturally, then eases into a stable position hold", () => {
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
    const cruiseSpeedMps = craft.getSpeedMps();
    for (let frame = 0; frame < 120; frame += 1) {
      craft.updateFlight(1 / 60, neutralFlightInput);
    }
    expect(craft.getSpeedMps()).toBeGreaterThan(cruiseSpeedMps * 0.88);

    craft.updateFlight(1 / 60, { ...neutralFlightInput, brake: true });
    for (let frame = 0; frame < 60; frame += 1) {
      craft.updateFlight(1 / 60, neutralFlightInput);
    }
    expect(craft.getSpeedMps()).toBeGreaterThan(cruiseSpeedMps * 0.1);
    expect(craft.getSpeedMps()).toBeLessThan(cruiseSpeedMps * 0.6);
    for (let frame = 0; frame < 900; frame += 1) {
      craft.updateFlight(1 / 60, neutralFlightInput);
    }
    expect(craft.getSpeedMps()).toBeLessThan(cruiseSpeedMps * 0.001);

    const heldPosition = craft.getAbsolute(new THREE.Vector3()).clone();
    for (let frame = 0; frame < 120; frame += 1) {
      craft.updateFlight(1 / 60, neutralFlightInput);
    }
    expect(craft.getAbsolute(new THREE.Vector3()).distanceTo(heldPosition)).toBe(0);

    craft.stopAndPark();
    const parkedPosition = craft.getAbsolute(new THREE.Vector3()).clone();
    craft.updateFlight(1, { ...neutralFlightInput, throttle: 1, boost: true });
    expect(craft.getSpeedMps()).toBe(0);
    expect(craft.getAbsolute(new THREE.Vector3()).distanceTo(parkedPosition)).toBe(0);
    craft.dispose();
  });

  it("applies an ultra warp impulse along the spacecraft nose", () => {
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
    const nose = craft.getForward(new THREE.Vector3()).clone();
    craft.updateFlight(1 / 60, { ...neutralFlightInput, warpBurst: true });

    const velocity = craft.getVelocity(new THREE.Vector3());
    expect(velocity.length()).toBeGreaterThan(SHIP_WARP_BURST_DELTA_V_M_S * 0.99);
    expect(velocity.clone().normalize().dot(nose)).toBeGreaterThan(0.9999);
    expect(craft.getWarpEffectIntensity()).toBeGreaterThan(0.9);
    expect(scene.getObjectByName("Spacecraft boost plume")?.visible).toBe(true);
    craft.dispose();
  });

  it("performs a strong assisted stop even after an ultra warp burst", () => {
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
    craft.updateFlight(1 / 60, { ...neutralFlightInput, warpBurst: true });
    for (let frame = 0; frame < 240; frame += 1) {
      craft.updateFlight(1 / 60, {
        ...neutralFlightInput,
        brake: true,
        brakeAccelerationMps2: 60_000,
      });
    }
    expect(craft.getSpeedMps()).toBe(0);
    craft.dispose();
  });

  it("sustains burst speed throughout destination-autopilot cruise", () => {
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
    for (let frame = 0; frame < 180; frame += 1) {
      craft.updateFlight(1 / 60, {
        ...neutralFlightInput,
        throttle: 1,
        boost: true,
        sustainedWarp: true,
        velocityAssistDirection: { x: 0, y: 0, z: 1 },
      });
      expect(craft.getSpeedMps()).toBeCloseTo(SHIP_AUTOPILOT_WARP_SPEED_M_S, 6);
    }
    expect(craft.getWarpEffectIntensity()).toBe(1);
    craft.dispose();
  });

  it("completes a cinematic autoland exactly on the selected terrain", () => {
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
    expect(craft.beginAutoland({ x: MARS_REFERENCE_RADIUS_M, y: 0, z: 0 })).toBe(true);
    let landed = false;
    for (let frame = 0; frame < 370; frame += 1) {
      landed = craft.updateAutoland(1 / 60) || landed;
    }
    const landedPosition = craft.getAbsolute(new THREE.Vector3());
    expect(landed).toBe(true);
    expect(landedPosition.clone().normalize().distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-8);
    expect(landedPosition.length()).toBeGreaterThan(MARS_REFERENCE_RADIUS_M);
    expect(landedPosition.length()).toBeLessThan(MARS_REFERENCE_RADIUS_M + 2);
    expect(craft.getSpeedMps()).toBe(0);
    craft.dispose();
  });

  it("uses a visibly distinct, longer-lived boost plume", () => {
    const normal = spaceshipTrailStyle(false);
    const boost = spaceshipTrailStyle(true);
    expect(boost.color).not.toEqual(normal.color);
    expect(boost.lifetimeS).toBeGreaterThan(normal.lifetimeS);
    expect(boost.pointIntervalS).toBeLessThan(normal.pointIntervalS);

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
    craft.updateFlight(1 / 60, { ...neutralFlightInput, throttle: 1 });
    expect(scene.getObjectByName("Spacecraft boost plume")?.visible).toBe(false);
    craft.updateFlight(1 / 60, { ...neutralFlightInput, throttle: 1, boost: true });
    expect(scene.getObjectByName("Spacecraft boost plume")?.visible).toBe(true);
    expect(scene.getObjectByName("Spacecraft boost hot core")?.visible).toBe(true);
    expect(scene.getObjectByName("Spacecraft boost shock diamond")?.visible).toBe(true);
    craft.dispose();
  });

  it("animates layered plume length, turbulence, and boost intensity over time", () => {
    const idleFrame = spaceshipPlumeAnimation(0, 0, false);
    const cruiseFrame = spaceshipPlumeAnimation(0, 1, false);
    const laterCruiseFrame = spaceshipPlumeAnimation(0.1, 1, false);
    const boostFrame = spaceshipPlumeAnimation(0.1, 1, true);

    expect(cruiseFrame.outerLengthScale).toBeGreaterThan(idleFrame.outerLengthScale);
    expect(laterCruiseFrame.outerLengthScale).not.toBe(cruiseFrame.outerLengthScale);
    expect(boostFrame.boostLengthScale).toBeGreaterThan(1);
    expect(boostFrame.boostOpacity).toBeGreaterThan(0.8);
    expect(boostFrame.shockPulse).not.toBe(spaceshipPlumeAnimation(0.2, 1, true).shockPulse);
  });
});
