import { describe, expect, it } from "vitest";
import {
  MARS_SURFACE_GRAVITY_M_S2,
  MARS_TRAVERSE_JUMP_SPEED_M_S,
} from "../app/planet/constants";
import {
  applyWowCameraDrag,
  dampCameraHeight,
  marsJumpApexHeight,
  randomMarsSurfaceDirection,
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

  it("damps terrain elevation changes instead of snapping the camera", () => {
    const next = dampCameraHeight(100, 120, 1 / 60);
    expect(next).toBeGreaterThan(100);
    expect(next).toBeLessThan(102);
    expect(dampCameraHeight(next, 120, 1 / 60)).toBeGreaterThan(next);
  });
});
