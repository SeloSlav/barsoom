import { describe, expect, it } from "vitest";
import { generateTerrainTile, TERRAIN_WORKER_REVISION as WORKER_REVISION } from "../public/workers/terrain-worker.js";
import { TERRAIN_WORKER_REVISION as CLIENT_REVISION } from "../app/planet/terrain/TerrainWorkerPool";
import { lodTransitionVisible, neighbourBalanceAncestors } from "../app/planet/terrain/PlanetTerrain";
import { neighbourTile, parentTile } from "../app/planet/math";
import { createTerrainMaterial, createTerrainShadowMaterial } from "../app/planet/render/materials";
import { generateSurfaceScatter } from "../app/planet/render/SurfaceDetailRenderer";

const MARS_REFERENCE_RADIUS_M = 3_389_500;

describe("terrain worker geometry", () => {
  it("generates a deterministic planet-anchored surface rock field", () => {
    const config = {
      radiusM: 420,
      spacingM: 35,
      density: 0.7,
      minimumSizeM: 0.2,
      maximumSizeM: 2.4,
      maximumInstances: 300,
      seedSalt: 0x74657374,
    };
    const center = { x: 0.61, y: 0.22, z: -0.76 };
    const first = generateSurfaceScatter(center, config);
    const restored = generateSurfaceScatter(center, config);
    expect(first.length).toBeGreaterThan(25);
    expect(first.length).toBeLessThanOrEqual(config.maximumInstances);
    expect(restored).toEqual(first);
    for (const point of first) {
      expect(Math.hypot(point.direction.x, point.direction.y, point.direction.z)).toBeCloseTo(1, 10);
      expect(point.sizeM).toBeGreaterThanOrEqual(config.minimumSizeM);
      expect(point.sizeM).toBeLessThanOrEqual(config.maximumSizeM);
    }
  });
  it("uses the same cache-busting revision in the client and worker", () => {
    expect(WORKER_REVISION).toBe(CLIENT_REVISION);
    const generated = generateTerrainTile({
      jobId: 0,
      key: { face: "px", lod: 0, x: 0, y: 0 },
      base: {
        key: { face: "px", lod: 0, x: 0, y: 0 },
        gridSize: 2,
        heightsM: new Int16Array(4),
        areoidM: new Int16Array(4),
      },
      segments: 1,
      skirtM: 140,
    });
    expect(generated.revision).toBe(CLIENT_REVISION);
  });
  it("uses complementary parent/child dither masks throughout an LOD transition", () => {
    for (const transition of [0.01, 0.2, 0.5, 0.8, 0.99]) {
      for (let sample = 0; sample < 1_000; sample += 1) {
        const dither = (sample + 0.5) / 1_000;
        const parent = lodTransitionVisible(dither, 1 - transition, false);
        const child = lodTransitionVisible(dither, transition, true);
        expect(Number(parent) + Number(child)).toBe(1);
      }
    }
  });

  it("forces every neighbour ancestor needed for a global 2:1 LOD balance", () => {
    const splitTile = { face: "px" as const, lod: 6, x: 63, y: 31 };
    for (const edge of ["north", "east", "south", "west"] as const) {
      const { neighbour, ancestors } = neighbourBalanceAncestors(splitTile, edge);
      expect(neighbour).toEqual(neighbourTile(splitTile, edge));
      expect(ancestors).toHaveLength(splitTile.lod);
      expect(ancestors.map((ancestor) => ancestor.lod)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(parentTile(neighbour)).toEqual(ancestors.at(-1));
      for (let index = 1; index < ancestors.length; index += 1) {
        expect(parentTile(ancestors[index])).toEqual(ancestors[index - 1]);
      }
    }
    expect(neighbourBalanceAncestors(splitTile, "east").neighbour.face).not.toBe(splitTile.face);
  });

  it("configures morph-aware directional cast shadows without skirt occluders", () => {
    const material = createTerrainMaterial();
    const depth = createTerrainShadowMaterial();
    expect(material.lights).toBe(true);
    expect("directionalLightShadows" in material.uniforms).toBe(true);
    expect(material.vertexShader).toContain("shadowmap_pars_vertex");
    expect(material.fragmentShader).toContain("shadowmap_pars_fragment");
    expect(depth.vertexShader).toContain("morphDelta");
    expect(depth.fragmentShader).toContain("vSurfaceMask < 0.5");
    material.dispose();
    depth.dispose();
  });

  it("bakes sampled MOLA elevations into the radial vertex positions", () => {
    const geometry = generateTerrainTile({
      jobId: 1,
      key: { face: "px", lod: 0, x: 0, y: 0 },
      base: {
        key: { face: "px", lod: 0, x: 0, y: 0 },
        gridSize: 2,
        heightsM: new Int16Array([0, 1_000, 2_000, 3_000]),
        areoidM: new Int16Array(4),
      },
      segments: 2,
      skirtM: 140,
    });

    const bakedHeights: number[] = [];
    for (let index = 0; index < 9; index += 1) {
      const offset = index * 3;
      const x = geometry.positions[offset] + geometry.center[0];
      const y = geometry.positions[offset + 1] + geometry.center[1];
      const z = geometry.positions[offset + 2] + geometry.center[2];
      bakedHeights.push(Math.hypot(x, y, z) - MARS_REFERENCE_RADIUS_M);
      expect(Math.abs(bakedHeights[index] - geometry.elevations[index])).toBeLessThan(0.12);
    }

    expect(Math.max(...bakedHeights) - Math.min(...bakedHeights)).toBeGreaterThan(2_990);
  });

  it("restores byte-identical terrain after leaving a tile and returning", () => {
    const base = {
      key: { face: "px", lod: 4, x: 7, y: 9 },
      gridSize: 2,
      heightsM: new Int16Array([120, 980, -430, 2_100]),
      areoidM: new Int16Array([10, 20, 30, 40]),
    } as const;
    const request = {
      jobId: 10,
      key: { face: "px", lod: 12, x: 1_903, y: 2_401 },
      base,
      segments: 24,
      skirtM: 140,
    } as const;
    const first = generateTerrainTile(request);
    generateTerrainTile({ ...request, jobId: 11, key: { face: "nx", lod: 10, x: 412, y: 291 } });
    const restored = generateTerrainTile({ ...request, jobId: 12 });
    for (const field of [
      "positions", "normals", "planetDirections", "elevations", "areoidElevations",
      "morphDelta", "tileUv", "surface", "indices",
    ] as const) {
      expect(Buffer.from(restored[field].buffer)).toEqual(Buffer.from(first[field].buffer));
    }
    expect(restored.center).toEqual(first.center);
  });

  it("adds deterministic mesh relief at playable ground scales", () => {
    const base = {
      key: { face: "px", lod: 4, x: 8, y: 8 },
      gridSize: 2,
      heightsM: new Int16Array(4),
      areoidM: new Int16Array(4),
    } as const;
    const request = {
      jobId: 20,
      key: { face: "px", lod: 16, x: 32_768, y: 32_768 },
      base,
      segments: 64,
      skirtM: 140,
    } as const;
    const first = generateTerrainTile(request);
    const second = generateTerrainTile({ ...request, jobId: 21 });
    const surfaceCount = (request.segments + 1) ** 2;
    const elevations = Array.from(first.elevations.slice(0, surfaceCount));

    expect(Math.max(...elevations) - Math.min(...elevations)).toBeGreaterThan(1);
    expect(Buffer.from(second.positions.buffer)).toEqual(Buffer.from(first.positions.buffer));
    expect(Buffer.from(second.elevations.buffer)).toEqual(Buffer.from(first.elevations.buffer));
  });
});
