export const SIMULATION_RATES = [60, 6, 1] as const;

export type SimulationRate = (typeof SIMULATION_RATES)[number];
export const DEFAULT_SIMULATION_RATE: SimulationRate = 1;

export function isSimulationRate(rate: number): rate is SimulationRate {
  return (SIMULATION_RATES as readonly number[]).includes(rate);
}

export function simulationUtcMsAt(
  simulationStartUtcMs: number,
  simulationStartPerformance: number,
  simulationRate: number,
  performanceTime: number,
) {
  return simulationStartUtcMs + (performanceTime - simulationStartPerformance) * simulationRate;
}

export function rebaseSimulationClock(
  simulationStartUtcMs: number,
  simulationStartPerformance: number,
  previousRate: number,
  performanceTime: number,
  nextRate: number,
) {
  if (!Number.isFinite(nextRate) || nextRate < 0) {
    throw new RangeError(`Invalid simulation rate: ${nextRate}`);
  }
  return {
    simulationStartUtcMs: simulationUtcMsAt(
      simulationStartUtcMs,
      simulationStartPerformance,
      previousRate,
      performanceTime,
    ),
    simulationStartPerformance: performanceTime,
    simulationRate: nextRate,
  };
}
