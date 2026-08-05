export type SovaTutorialId = "telescope" | "surface" | "spaceman";

export const SOVA_TUTORIAL_EVENT = "barsoom:sova-tutorial";

export type SovaTutorialDefinition = {
  id: SovaTutorialId;
  sequence: string;
  title: string;
  audioSrc: string;
  body: readonly string[];
};

export const SOVA_TUTORIALS: Record<SovaTutorialId, SovaTutorialDefinition> = {
  telescope: {
    id: "telescope",
    sequence: "BRIEFING 01 / APERTURE",
    title: "This is not a live telescope image",
    audioSrc: "/audio/sova-quantum-telescope.mp3",
    body: [
      "SOVA online. Welcome to the Cauchy Array. What you are seeing is not a conventional telescope image, and it is not instantaneous. Receivers in a distributed optical interferometer collect real photons that left Mars several minutes ago.",
      "Quantum-enhanced clocks, squeezed-light measurements, and phase references reduce uncertainty as the baselines are combined; elevation data supplies a geometric prior. Entanglement improves measurement precision—it does not transmit an image or information faster than light. You and I are operating from a compartmentalized site on Earth to identify a landing region before our autonomous colonization swarm departs. Quietly, preferably.",
    ],
  },
  surface: {
    id: "surface",
    sequence: "BRIEFING 02 / PHASE LOCK",
    title: "A coordinate is a hypothesis",
    audioSrc: "/audio/sova-surface-selection.mp3",
    body: [
      "A surface click phase-locks the reconstruction to that coordinate. The wheel changes focal height around the selected point. Right-click releases it; middle-mouse drag rotates the solved field, and right-mouse drag shifts the virtual aperture.",
      "Evaluate elevation, relief, slopes, illumination, and approach geometry. Lower terrain offers more atmosphere for entry, gentle ground reduces landing risk, and latitude affects solar power and thermal cycles. This optical survey cannot prove buried ice or soil strength, so promising regions still need orbital radar and robotic scouts. We are choosing where machines must land, survive, make power, find water, and build the first logistics chain.",
    ],
  },
  spaceman: {
    id: "spaceman",
    sequence: "BRIEFING 03 / LOCAL PROXY",
    title: "The spaceman is not a person",
    audioSrc: "/audio/sova-spaceman.mp3",
    body: [
      "No human was teleported to Mars. The spaceman is a kinematic scale proxy instantiated inside the reconstructed light field. Its feet follow the rendered terrain model, and its jump uses measured Martian surface gravity: 3.721 metres per second squared. Use WASD to move, Shift to run, Space to jump, and the mouse to inspect human-scale relief.",
      "The real mission is an AI-enabled robotic swarm: scouts map, cargo units deploy power, excavators expose ice-bearing material, in-situ systems make water, oxygen, and fuel, and construction units build shielded habitats. Terraforming is a speculative, generations-long objective constrained by energy, volatiles, low gravity, and atmospheric loss. The immediate objective is simpler: give autonomous infrastructure its first survivable foothold.",
    ],
  },
};

export function isSovaTutorialId(value: unknown): value is SovaTutorialId {
  return value === "telescope" || value === "surface" || value === "spaceman";
}

export function emitSovaTutorial(id: SovaTutorialId) {
  window.dispatchEvent(new CustomEvent(SOVA_TUTORIAL_EVENT, { detail: { id } }));
}
