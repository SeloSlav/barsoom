export const DEFAULT_ORBITAL_STANDOFF_RADII = 3.1;
export const DEIMOS_INITIAL_STANDOFF_RADII = 18;
export const MAX_ORBITAL_STANDOFF_RADII = 30;

export function initialOrbitalStandoffRadii(body: string) {
  return body === "Deimos"
    ? DEIMOS_INITIAL_STANDOFF_RADII
    : DEFAULT_ORBITAL_STANDOFF_RADII;
}
