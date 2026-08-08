import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORBITAL_STANDOFF_RADII,
  DEIMOS_INITIAL_STANDOFF_RADII,
  initialOrbitalStandoffRadii,
  MAX_ORBITAL_STANDOFF_RADII,
} from "../app/planet/orbitalCamera";
import {
  DEFAULT_SIMULATION_RATE,
  isSimulationRate,
  rebaseSimulationClock,
  SIMULATION_RATES,
  simulationUtcMsAt,
} from "../app/planet/simulationClock";

describe("simulation rate control", () => {
  it("offers the requested accelerated and real-time rates", () => {
    expect(SIMULATION_RATES).toEqual([60, 6, 1]);
    expect(DEFAULT_SIMULATION_RATE).toBe(1);
    expect(SIMULATION_RATES.every(isSimulationRate)).toBe(true);
    expect(isSimulationRate(10)).toBe(false);
  });

  it("rebases a rate change without jumping the simulation epoch", () => {
    const before = simulationUtcMsAt(1_000_000, 10_000, 60, 12_500);
    const rebased = rebaseSimulationClock(1_000_000, 10_000, 60, 12_500, 6);
    expect(rebased.simulationStartUtcMs).toBe(before);
    expect(simulationUtcMsAt(
      rebased.simulationStartUtcMs,
      rebased.simulationStartPerformance,
      rebased.simulationRate,
      13_500,
    )).toBe(before + 6_000);
  });

  it("rejects invalid rates but retains the zero-rate developer freeze", () => {
    expect(() => rebaseSimulationClock(0, 0, 1, 1, -1)).toThrow(RangeError);
    expect(rebaseSimulationClock(0, 0, 1, 1, 0).simulationRate).toBe(0);
  });
});

describe("orbital target framing", () => {
  it("starts Deimos wide enough to preserve its Mars context", () => {
    expect(initialOrbitalStandoffRadii("Phobos")).toBe(DEFAULT_ORBITAL_STANDOFF_RADII);
    expect(initialOrbitalStandoffRadii("Mars Odyssey")).toBe(DEFAULT_ORBITAL_STANDOFF_RADII);
    expect(initialOrbitalStandoffRadii("Deimos")).toBe(DEIMOS_INITIAL_STANDOFF_RADII);
    expect(DEIMOS_INITIAL_STANDOFF_RADII).toBeGreaterThan(DEFAULT_ORBITAL_STANDOFF_RADII * 5);
    expect(DEIMOS_INITIAL_STANDOFF_RADII).toBeLessThan(MAX_ORBITAL_STANDOFF_RADII);
  });
});
