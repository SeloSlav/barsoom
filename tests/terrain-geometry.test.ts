import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  generateTerrainTile,
  terrainDetailHeightForLod as workerTerrainDetailHeightForLod,
  TERRAIN_WORKER_REVISION as WORKER_REVISION,
} from "../public/workers/terrain-worker.js";
import { TERRAIN_WORKER_REVISION as CLIENT_REVISION } from "../app/planet/terrain/TerrainWorkerPool";
import {
  coarserNeighbourEdgeMorphs,
  lodTransitionVisible,
  neighbourBalanceAncestors,
  sampleMorphedTerrainGrid,
} from "../app/planet/terrain/PlanetTerrain";
import { faceUvToDirection, neighbourTile, parentTile, tileKeyToString } from "../app/planet/math";
import { latLonElevationToCartesian } from "../app/planet/math";
import { proceduralTerrainHeightForLod } from "../app/planet/noise";
import { createAtmosphereMaterial, createTerrainMaterial, createTerrainShadowMaterial } from "../app/planet/render/materials";
import {
  calculateSurfaceRockPlacement,
  createSurfaceRockMaterial,
  generateSurfaceScatter,
} from "../app/planet/render/SurfaceDetailRenderer";

const MARS_REFERENCE_RADIUS_M = 3_389_500;

describe("terrain worker geometry", () => {
  it("samples the exact shader-morphed triangle used as visible ground", () => {
    const key = { face: "px", lod: 0, x: 0, y: 0 } as const;
    const childRadiusM = MARS_REFERENCE_RADIUS_M + 120;
    const parentRadiusM = MARS_REFERENCE_RADIUS_M - 60;
    const corners = [
      faceUvToDirection("px", -1, -1),
      faceUvToDirection("px", 1, -1),
      faceUvToDirection("px", -1, 1),
      faceUvToDirection("px", 1, 1),
    ];
    const positions = new Float64Array(corners.flatMap((direction) => [
      direction.x * childRadiusM,
      direction.y * childRadiusM,
      direction.z * childRadiusM,
    ]));
    const morphDeltas = new Float64Array(corners.flatMap((direction) => [
      direction.x * (childRadiusM - parentRadiusM),
      direction.y * (childRadiusM - parentRadiusM),
      direction.z * (childRadiusM - parentRadiusM),
    ]));
    const direction = { x: 1, y: 0, z: 0 };

    const parent = sampleMorphedTerrainGrid(
      direction, key, { x: 0, y: 0, z: 0 }, positions, morphDeltas, 0, undefined, 1,
    );
    const halfway = sampleMorphedTerrainGrid(
      direction, key, { x: 0, y: 0, z: 0 }, positions, morphDeltas, 0.5, undefined, 1,
    );
    const child = sampleMorphedTerrainGrid(
      direction, key, { x: 0, y: 0, z: 0 }, positions, morphDeltas, 1, undefined, 1,
    );

    expect(parent?.radiusM).toBeCloseTo(parentRadiusM / Math.sqrt(3), 7);
    expect(halfway?.radiusM).toBeCloseTo((parentRadiusM + childRadiusM) / (2 * Math.sqrt(3)), 7);
    expect(child?.radiusM).toBeCloseTo(childRadiusM / Math.sqrt(3), 7);
    expect(child?.normal.x).toBeCloseTo(1, 12);
    expect(child?.normal.y).toBeCloseTo(0, 12);
    expect(child?.normal.z).toBeCloseTo(0, 12);
  });

  it("ships an 8K USGS orbital mosaic, full PBR maps, and a surface-visible aerosol atmosphere", async () => {
    const jpeg = await readFile(path.join(process.cwd(), "public/textures/mars-viking-global-8k.jpg"));
    const diffuse = await readFile(path.join(process.cwd(), "public/textures/mars-rock-diffuse.jpg"));
    const normal = await readFile(path.join(process.cwd(), "public/textures/mars-rock-normal-gl.jpg"));
    const roughness = await readFile(path.join(process.cwd(), "public/textures/mars-rock-roughness.jpg"));
    expect(jpeg.byteLength).toBeGreaterThan(9_000_000);
    expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect(diffuse.byteLength).toBeGreaterThan(750_000);
    expect(normal.byteLength).toBeGreaterThan(1_300_000);
    expect(roughness.byteLength).toBeGreaterThan(450_000);
    const atmosphere = createAtmosphereMaterial();
    expect(atmosphere.fragmentShader).toContain("dustySky");
    expect(atmosphere.fragmentShader).toContain("surfaceAlpha");
    atmosphere.dispose();
  });
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
  it("keeps shadowed surface rocks readable under dusty-sky fill", () => {
    const material = createSurfaceRockMaterial();
    expect(material.metalness).toBe(0);
    expect(material.roughness).toBeLessThan(0.97);
    expect(material.emissiveIntensity).toBeGreaterThanOrEqual(0.2);
    expect(material.vertexColors).toBe(true);
    material.dispose();
  });
  it("seats surface rocks on the exact rendered terrain triangle", () => {
    const point = {
      direction: { x: 0.61, y: 0.22, z: -0.76 },
      sizeM: 2.4,
      yawRad: 0.4,
      stretch: { x: 0.8, y: 1.15, z: 0.9 },
      tint: 0.5,
    };
    const supportNormalLength = Math.hypot(0.78, 0.42, -0.16);
    const support = {
      radiusM: MARS_REFERENCE_RADIUS_M + 187.25,
      normal: {
        x: 0.78 / supportNormalLength,
        y: 0.42 / supportNormalLength,
        z: -0.16 / supportNormalLength,
      },
    };
    const placement = calculateSurfaceRockPlacement(point, support);
    const directionLength = Math.hypot(point.direction.x, point.direction.y, point.direction.z);
    const direction = {
      x: point.direction.x / directionLength,
      y: point.direction.y / directionLength,
      z: point.direction.z / directionLength,
    };
    const surface = {
      x: direction.x * support.radiusM,
      y: direction.y * support.radiusM,
      z: direction.z * support.radiusM,
    };
    const offset = {
      x: placement.absolute.x - surface.x,
      y: placement.absolute.y - surface.y,
      z: placement.absolute.z - surface.z,
    };
    const normalOffset = offset.x * placement.normal.x + offset.y * placement.normal.y + offset.z * placement.normal.z;
    expect(normalOffset).toBeCloseTo(placement.scale.y * 0.32, 6);
    expect(Math.hypot(placement.normal.x, placement.normal.y, placement.normal.z)).toBeCloseTo(1, 10);
    expect(placement.normal).toEqual(support.normal);
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

  it("morphs only edges that actually border a visible coarser tile", () => {
    const tile = { face: "px" as const, lod: 6, x: 31, y: 24 };
    const west = neighbourBalanceAncestors(tile, "west").neighbour;
    const east = neighbourBalanceAncestors(tile, "east");
    const north = neighbourBalanceAncestors(tile, "north").neighbour;
    const visible = new Set([
      tileKeyToString(west),
      tileKeyToString(north),
      tileKeyToString(east.ancestors.at(-1)!),
    ]);
    expect(coarserNeighbourEdgeMorphs(tile, visible)).toEqual([0, 1, 0, 0]);
    expect(coarserNeighbourEdgeMorphs(tile, new Set())).toEqual([0, 0, 0, 0]);
  });

  it("configures morph-aware directional cast shadows without skirt occluders", () => {
    const material = createTerrainMaterial();
    const depth = createTerrainShadowMaterial();
    expect(material.lights).toBe(true);
    expect("directionalLightShadows" in material.uniforms).toBe(true);
    expect(material.uniforms.uOrbitalTexture.value.name).toContain("USGS Viking MDIM 2.1");
    expect(material.uniforms.uSurfaceDiffuse.value.name).toContain("rocks ground 02 diffuse");
    expect(material.uniforms.uSurfaceNormal.value.name).toContain("OpenGL normal");
    expect(material.uniforms.uSurfaceRoughness.value.name).toContain("roughness");
    expect(material.vertexShader).toContain("shadowmap_pars_vertex");
    expect(material.fragmentShader).toContain("shadowmap_pars_fragment");
    expect(material.fragmentShader).toContain("distributionGgx");
    expect(material.fragmentShader).toContain("texture2D(uOrbitalTexture");
    expect(material.fragmentShader).toContain("sampleSurfaceDiffuse");
    expect(material.fragmentShader).toContain("rotateSurfaceUv");
    expect(material.fragmentShader).toContain("sampleSurfaceDiffuseProjection");
    expect(material.fragmentShader).toContain("sampleSurfaceRoughnessProjection");
    expect(material.fragmentShader).toContain("sampleSurfaceNormalProjection");
    expect(material.fragmentShader).toContain("surfaceMapBlend");
    expect(material.fragmentShader).not.toContain("sampleRandomizedSurfaceDiffuse");
    expect(material.fragmentShader).not.toContain("surfaceAntiTile");
    expect(material.fragmentShader).toContain("surfaceAlbedoVisibility");
    expect(material.fragmentShader).toContain("surfaceMaterialResponse");
    expect(material.fragmentShader).toContain("sampleSurfaceNormal");
    expect(material.fragmentShader).toContain("sampleSurfaceRoughness");
    expect(depth.vertexShader).toContain("morphDelta");
    expect(material.vertexShader).toContain("uEdgeMorph");
    expect(depth.vertexShader).toContain("uEdgeMorph");
    expect(material.vertexShader).not.toContain("boundaryMorph");
    expect(depth.fragmentShader).toContain("vSurfaceMask < 0.5");
    material.uniforms.uOrbitalTexture.value.dispose();
    material.uniforms.uSurfaceDiffuse.value.dispose();
    material.uniforms.uSurfaceNormal.value.dispose();
    material.uniforms.uSurfaceRoughness.value.dispose();
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

  it("morphs odd child-edge vertices onto the exact parent triangle edge", () => {
    const segments = 24;
    const base = {
      key: { face: "px" as const, lod: 0, x: 0, y: 0 },
      gridSize: 2,
      heightsM: new Int16Array(4),
      areoidM: new Int16Array(4),
    };
    const parent = generateTerrainTile({
      jobId: 30,
      key: { face: "px", lod: 4, x: 7, y: 9 },
      base,
      segments,
      skirtM: 140,
    });
    const child = generateTerrainTile({
      jobId: 31,
      key: { face: "px", lod: 5, x: 14, y: 19 },
      base,
      segments,
      skirtM: 140,
    });
    const gridSize = segments + 1;
    const childIndex = 7 * gridSize;
    const parentA = 15 * gridSize;
    const parentB = 16 * gridSize;
    for (let axis = 0; axis < 3; axis += 1) {
      const morphedChild = child.positions[childIndex * 3 + axis] + child.center[axis] -
        child.morphDelta[childIndex * 3 + axis];
      const expectedParent = (
        parent.positions[parentA * 3 + axis] + parent.center[axis] +
        parent.positions[parentB * 3 + axis] + parent.center[axis]
      ) * 0.5;
      expect(Math.abs(morphedChild - expectedParent)).toBeLessThan(0.15);
    }
  });

  it("keeps playable-LOD skirts below one metre instead of forming 140 m walls", () => {
    const segments = 24;
    const geometry = generateTerrainTile({
      jobId: 32,
      key: { face: "px", lod: 18, x: 131_072, y: 131_072 },
      base: {
        key: { face: "px", lod: 0, x: 0, y: 0 },
        gridSize: 2,
        heightsM: new Int16Array(4),
        areoidM: new Int16Array(4),
      },
      segments,
      skirtM: 140,
    });
    const skirtIndex = (segments + 1) ** 2;
    const skirtDepth = Math.hypot(
      geometry.positions[skirtIndex * 3] - geometry.positions[0],
      geometry.positions[skirtIndex * 3 + 1] - geometry.positions[1],
      geometry.positions[skirtIndex * 3 + 2] - geometry.positions[2],
    );
    expect(skirtDepth).toBeGreaterThan(0.3);
    expect(skirtDepth).toBeLessThan(1);
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

  it("keeps main-thread sampling byte-equivalent with the worker height bands", () => {
    for (const lod of [0, 9, 10, 13, 16, 18]) {
      for (const [latitude, longitude] of [[0, 0], [18.38, 77.58], [-32.1, -142.7], [73, 164.5]]) {
        const direction = latLonElevationToCartesian(latitude, longitude, 0, 1);
        const mainHeight = proceduralTerrainHeightForLod(direction, lod);
        const workerHeight = workerTerrainDetailHeightForLod([direction.x, direction.y, direction.z], lod);
        expect(workerHeight).toBeCloseTo(mainHeight, 10);
      }
    }
  });
});
