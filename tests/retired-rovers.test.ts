import * as THREE from "three";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MARS_REFERENCE_RADIUS_M } from "../app/planet/constants";
import { MARS_LANDMARKS } from "../app/planet/landmarks";
import {
  createRetiredRoverModel,
  fitRoverAssetToPhysicalSize,
  RETIRED_ROVER_ASSET_SPECS,
} from "../app/planet/render/RetiredRoverRenderer";
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

function inspectGlb(publicPath: string) {
  const filePath = fileURLToPath(new URL(`../public${publicPath.split("?")[0]}`, import.meta.url));
  const file = readFileSync(filePath);
  expect(file.subarray(0, 4).toString("ascii")).toBe("glTF");
  const jsonLength = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8").trim());
  const primitives = json.meshes.flatMap((mesh: { primitives: unknown[] }) => mesh.primitives);
  const triangles = primitives.reduce((total: number, primitive: { indices?: number }) => {
    if (primitive.indices === undefined) return total;
    return total + json.accessors[primitive.indices].count / 3;
  }, 0);
  return { bytes: statSync(filePath).size, primitives: primitives.length, triangles };
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

  it("keeps the detailed rover assets inside a small lazy-load render budget", () => {
    const summaries = Object.values(RETIRED_ROVER_ASSET_SPECS).map((spec) => inspectGlb(spec.path));
    expect(summaries.reduce((total, summary) => total + summary.bytes, 0)).toBeLessThan(512 * 1024);
    expect(summaries.reduce((total, summary) => total + summary.primitives, 0)).toBeLessThanOrEqual(20);
    expect(summaries.reduce((total, summary) => total + summary.triangles, 0)).toBeLessThan(25_000);
  });

  it("normalizes source models to their physical dimensions and ground plane", () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 4, 8)));
    fitRoverAssetToPhysicalSize(root, { x: 2.3, y: 1.5, z: 1.6 });
    const bounds = new THREE.Box3().setFromObject(root);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    expect(size.x).toBeCloseTo(2.3, 8);
    expect(size.y).toBeCloseTo(1.5, 8);
    expect(size.z).toBeCloseTo(1.6, 8);
    expect(bounds.min.y).toBeCloseTo(0, 8);
    expect(center.x).toBeCloseTo(0, 8);
    expect(center.z).toBeCloseTo(0, 8);
    disposeModel(root);
  });
});
