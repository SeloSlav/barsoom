import { describe, expect, it } from "vitest";
import type { MarsSkyState } from "../app/planet/ephemeris";
import { LocalLightingPhaseLock } from "../app/planet/render/LocalLightingPhaseLock";

function skyAt(second: number): MarsSkyState {
  return {
    utc: new Date(Date.UTC(2026, 7, 5, 22, 0, second)),
    sunDirection: { x: 1, y: second / 100, z: 0 },
    sunAngularRadiusRad: 0.003,
    inertialToMarsFixed: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    bodies: [],
  };
}

describe("local lighting stability", () => {
  it("holds one coherent sky while local lighting is phase-locked", () => {
    const lock = new LocalLightingPhaseLock();
    const first = skyAt(1);
    const later = skyAt(45);

    expect(lock.resolve(first, false)).toBe(first);
    expect(lock.resolve(first, true)).toBe(first);
    expect(lock.resolve(later, true)).toBe(first);
  });

  it("releases and explicitly retargets the local lighting solution", () => {
    const lock = new LocalLightingPhaseLock();
    const first = skyAt(1);
    const later = skyAt(45);

    lock.resolve(first, true);
    expect(lock.resolve(later, false)).toBe(later);
    expect(lock.resolve(later, true)).toBe(later);

    lock.reset();
    const retargeted = skyAt(50);
    expect(lock.resolve(retargeted, true)).toBe(retargeted);
  });
});
