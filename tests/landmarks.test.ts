import { describe, expect, it } from "vitest";
import { findMarsLandmarkAtDirection, landmarkDirection, MARS_LANDMARKS } from "../app/planet/landmarks";

describe("Mars landmark surface picking", () => {
  it("resolves every landmark at its geographic centre", () => {
    for (const landmark of MARS_LANDMARKS) {
      expect(findMarsLandmarkAtDirection(landmarkDirection(landmark))?.landmark.id).toBe(landmark.id);
    }
  });

  it("does not label ordinary terrain outside landmark footprints", () => {
    const ordinaryTerrain = landmarkDirection({
      id: "ordinary",
      name: "Ordinary terrain",
      featureType: "Terrain",
      latitudeDeg: 0,
      longitudeDeg: 0,
      hoverRadiusKm: 1,
    });
    expect(findMarsLandmarkAtDirection(ordinaryTerrain)).toBeNull();
  });

  it("keeps curated scenic landing coordinates for the former relief presets", () => {
    const olympus = MARS_LANDMARKS.find((landmark) => landmark.id === "olympus-mons");
    const noctis = MARS_LANDMARKS.find((landmark) => landmark.id === "noctis-labyrinthus");
    expect(olympus?.landingLatitudeDeg).toBeCloseTo(23.35);
    expect(noctis?.landingLongitudeDeg).toBeCloseTo(-100.0025);
  });
});
