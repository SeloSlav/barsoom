import { describe, expect, it } from "vitest";
import {
  MARS_SURFACE_GRAVITY_M_S2,
  MARS_TRAVERSE_JUMP_SPEED_M_S,
} from "../app/planet/constants";
import {
  applyWowCameraDrag,
  marsJumpApexHeight,
  normalizeMarsSurfaceDirection,
  randomMarsSurfaceDirection,
  smoothCameraHeight,
  wowMouseAutoRun,
} from "../app/planet/SurfaceTraverseController";

describe("surface traverse physics", () => {
  it("uses Mars gravity for a long, low-gravity jump arc", () => {
    expect(MARS_SURFACE_GRAVITY_M_S2).toBeCloseTo(3.721, 6);
    expect(marsJumpApexHeight()).toBeCloseTo(
      MARS_TRAVERSE_JUMP_SPEED_M_S ** 2 / (2 * 3.721),
      8,
    );
    expect(marsJumpApexHeight()).toBeGreaterThan(3);
  });

  it("generates unit-length surface directions across the sphere", () => {
    const values = [0, 0, 0.5, 0.25, 1, 0.75];
    let index = 0;
    const random = () => values[index++];
    const southPole = randomMarsSurfaceDirection(random);
    const equator = randomMarsSurfaceDirection(random);
    const northPole = randomMarsSurfaceDirection(random);

    expect(southPole).toEqual({ x: 0, y: -1, z: 0 });
    expect(equator.y).toBe(0);
    expect(Math.hypot(equator.x, equator.y, equator.z)).toBeCloseTo(1, 12);
    expect(northPole.y).toBe(1);
    expect(Math.hypot(northPole.x, northPole.z)).toBe(0);
  });

  it("preserves an exact locked surface target for observer instantiation", () => {
    const target = normalizeMarsSurfaceDirection({ x: 2, y: -3, z: 6 });

    expect(target.x).toBeCloseTo(2 / 7, 12);
    expect(target.y).toBeCloseTo(-3 / 7, 12);
    expect(target.z).toBeCloseTo(6 / 7, 12);
    expect(Math.hypot(target.x, target.y, target.z)).toBeCloseTo(1, 12);
    expect(() => normalizeMarsSurfaceDirection({ x: 0, y: 0, z: 0 })).toThrow(RangeError);
  });

  it("orbits freely with left drag and steers the astronaut with right drag", () => {
    const leftDrag = applyWowCameraDrag(0.4, 0.3, 1.2, -40, -20, false);
    expect(leftDrag.cameraYawRad).toBeLessThan(0.4);
    expect(leftDrag.cameraPitchRad).toBeGreaterThan(0.3);
    expect(leftDrag.headingRad).toBe(1.2);

    const rightDrag = applyWowCameraDrag(0.4, 0.3, 1.2, 40, -20, true);
    expect(rightDrag.cameraYawRad).toBeGreaterThan(0.4);
    expect(rightDrag.headingRad).toBe(rightDrag.cameraYawRad);
  });

  it("allows upward mouselook past the horizon", () => {
    const lookingUp = applyWowCameraDrag(0, 0.1, 0, 0, -500, true);
    expect(lookingUp.cameraPitchRad).toBeGreaterThan(0);
    expect(lookingUp.cameraPitchRad).toBeCloseTo(85 * Math.PI / 180, 12);
  });

  it("moves forward only while both mouse buttons are held", () => {
    expect(wowMouseAutoRun(true, true)).toBe(true);
    expect(wowMouseAutoRun(true, false)).toBe(false);
    expect(wowMouseAutoRun(false, true)).toBe(false);
  });

  it("follows terrain elevation with continuous, speed-bounded camera motion", () => {
    let heightM = 100;
    let velocityMps = 0;
    let previousStepM = 0;

    for (let frame = 0; frame < 120; frame += 1) {
      // Deliberately alternate implausibly large terrain samples. Even this
      // worst case must not create a one-frame camera displacement.
      const targetHeightM = frame % 2 === 0 ? 1_000 : -1_000;
      const next = smoothCameraHeight(heightM, targetHeightM, velocityMps, 1 / 60);
      const stepM = next.heightM - heightM;

      expect(Math.abs(stepM)).toBeLessThanOrEqual(8 / 60 + 1e-6);
      expect(Math.abs(stepM - previousStepM)).toBeLessThan(0.08);
      heightM = next.heightM;
      velocityMps = next.velocityMps;
      previousStepM = stepM;
    }
  });

  it("converges smoothly to a sustained elevation change", () => {
    let motion = { heightM: 100, velocityMps: 0 };
    for (let frame = 0; frame < 300; frame += 1) {
      motion = smoothCameraHeight(motion.heightM, 120, motion.velocityMps, 1 / 60);
    }

    expect(motion.heightM).toBeCloseTo(120, 4);
    expect(Math.abs(motion.velocityMps)).toBeLessThan(0.001);
  });
});
