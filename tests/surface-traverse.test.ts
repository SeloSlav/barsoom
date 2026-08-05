import { describe, expect, it } from "vitest";
import {
  MARS_SURFACE_GRAVITY_M_S2,
  MARS_TRAVERSE_JUMP_SPEED_M_S,
} from "../app/planet/constants";
import {
  marsJumpApexHeight,
  randomMarsSurfaceDirection,
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
});
