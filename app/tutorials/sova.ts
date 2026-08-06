export type SovaTutorialId = "telescope" | "surface" | "spaceman";

export const SOVA_TUTORIAL_EVENT = "barsoom:sova-tutorial";

export type SovaTutorialDefinition = {
  id: SovaTutorialId;
  sequence: string;
  title: string;
  audioSrc: string;
  autoPlayDelayMs: number;
  body: readonly [string];
};

export const SOVA_TUTORIALS: Record<SovaTutorialId, SovaTutorialDefinition> = {
  telescope: {
    id: "telescope",
    sequence: "BRIEFING 01 / APERTURE",
    title: "This is not a live telescope image",
    audioSrc: "/audio/sova-quantum-telescope.mp3",
    autoPlayDelayMs: 0,
    body: [
      "SOVA online. From our clandestine Cauchy Array site on Earth, you are reconstructing Mars from real photons that departed minutes ago—not watching a live feed. Quantum-enhanced clocks and interferometry sharpen the solution without sending information faster than light. Use the wheel to zoom through the solved light field; the telescope never moves. Your task is to find a landing zone before our autonomous colonization swarm launches.",
    ],
  },
  surface: {
    id: "surface",
    sequence: "BRIEFING 02 / PHASE LOCK",
    title: "A coordinate is a hypothesis",
    audioSrc: "/audio/sova-surface-selection.mp3",
    autoPlayDelayMs: 1_300,
    body: [
      "Click Mars to phase-lock the reconstruction to a candidate landing site, then scroll to descend and inspect it; right-click releases the lock. Judge elevation, slope, light, and approach geometry—low, gentle ground gives the swarm more atmosphere for entry and a safer first foothold. The array cannot see buried ice or soil strength, so this coordinate is a hypothesis our orbital radar and robotic scouts must test.",
    ],
  },
  spaceman: {
    id: "spaceman",
    sequence: "BRIEFING 03 / LOCAL PROXY",
    title: "The spaceman is not a person",
    audioSrc: "/audio/sova-spaceman.mp3",
    autoPlayDelayMs: 2_300,
    body: [
      "No human was teleported to Mars. This spaceman is a scale proxy inside the reconstructed field. Use WASD to move, Shift to run, Space to jump, and the mouse to inspect terrain at human scale under Martian gravity. Read every ridge as a construction problem: our autonomous scouts, excavators, and builders must find water, make power, and raise shielded habitats before any human follows.",
    ],
  },
};

export function isSovaTutorialId(value: unknown): value is SovaTutorialId {
  return value === "telescope" || value === "surface" || value === "spaceman";
}

export function emitSovaTutorial(id: SovaTutorialId) {
  window.dispatchEvent(new CustomEvent(SOVA_TUTORIAL_EVENT, { detail: { id } }));
}
