import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { MARS_REFERENCE_RADIUS_M } from "../app/planet/constants";
import { MARS_LANDMARKS } from "../app/planet/landmarks";
import { createRetiredRoverModel } from "../app/planet/render/RetiredRoverRenderer";
import {
  RETIRED_ROVER_SITES,
  roverModelBasis,
  roverSiteDirection,
  roverVisitCoordinates,
} from "../app/planet/roverSites";

function disposeModel(root: THREE.Group) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
    meshMaterials.forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

describe("retired Mars rover heritage sites", () => {
  it("contains only the three conclusively completed rover missions", () => {
    expect(RETIRED_ROVER_SITES.map((site) => site.name)).toEqual([
      "Sojourner",
      "Spirit",
      "Opportunity",
    ]);
    expect(RETIRED_ROVER_SITES.some((site) => ["Curiosity", "Perseverance", "Zhurong"].includes(site.name))).toBe(false);
    expect(RETIRED_ROVER_SITES.every((site) => site.missionEndYear <= 2019)).toBe(true);
  });

  it("exposes each rover as a distinct globe highlight with a nearby visit point", () => {
    for (const site of RETIRED_ROVER_SITES) {
      const landmark = MARS_LANDMARKS.find((candidate) => candidate.id === site.id);
      expect(landmark?.kind).toBe("retired-rover");
      expect(landmark?.latitudeDeg).toBe(site.latitudeDeg);
      expect(landmark?.longitudeDeg).toBe(site.longitudeDeg);
      const visit = roverVisitCoordinates(site);
      expect(landmark?.landingLatitudeDeg).toBe(visit.latitudeDeg);
      expect(landmark?.landingLongitudeDeg).toBe(visit.longitudeDeg);
      const separationM = Math.abs(site.latitudeDeg - visit.latitudeDeg) * Math.PI / 180 * MARS_REFERENCE_RADIUS_M;
      expect(separationM).toBeCloseTo(site.visitDistanceM, 6);
      expect(visit.headingRad).toBe(0);
    }
  });

  it("builds orthonormal terrain-aligned rover frames", () => {
    for (const site of RETIRED_ROVER_SITES) {
      const radial = roverSiteDirection(site);
      const basis = roverModelBasis(site, radial);
      for (const axis of [basis.right, basis.up, basis.forward]) {
        expect(Math.hypot(axis.x, axis.y, axis.z)).toBeCloseTo(1, 10);
      }
      expect(basis.right.x * basis.up.x + basis.right.y * basis.up.y + basis.right.z * basis.up.z).toBeCloseTo(0, 10);
      expect(basis.forward.x * basis.up.x + basis.forward.y * basis.up.y + basis.forward.z * basis.up.z).toBeCloseTo(0, 10);
    }
  });

  it("creates recognizable six-wheel models at their physical scale", () => {
    for (const modelType of ["sojourner", "mer"] as const) {
      const model = createRetiredRoverModel(modelType);
      const wheels = model.children.filter((child) => child.name.startsWith("Wheel "));
      expect(wheels).toHaveLength(6);
      model.updateMatrixWorld(true);
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      if (modelType === "sojourner") {
        expect(size.x).toBeGreaterThan(0.5);
        expect(size.x).toBeLessThan(0.8);
        expect(size.y).toBeLessThan(0.5);
      } else {
        expect(size.x).toBeGreaterThan(3.1);
        expect(size.x).toBeLessThan(4.1);
        expect(size.y).toBeGreaterThan(2);
      }
      disposeModel(model);
    }
  });
});
