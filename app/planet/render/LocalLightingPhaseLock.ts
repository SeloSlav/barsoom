import type { MarsSkyState } from "../ephemeris";

/**
 * Holds one coherent celestial solution while the renderer is close enough to
 * resolve local shadows. At the normal 60x model rate, advancing Mars' sky on
 * every display frame rotates a directional shadow map by several texels per
 * second even when the observer is completely still. The orbital view remains
 * live; only the phase-locked local reconstruction is held stable.
 */
export class LocalLightingPhaseLock {
  private lockedSky: MarsSkyState | null = null;

  resolve(liveSky: MarsSkyState, active: boolean) {
    if (!active) {
      this.lockedSky = null;
      return liveSky;
    }
    this.lockedSky ??= liveSky;
    return this.lockedSky;
  }

  reset() {
    this.lockedSky = null;
  }
}
