import { describe, expect, it } from "vitest";
import { generateTerrainTile } from "../public/workers/terrain-worker.js";
import { lodTransitionVisible, neighbourBalanceAncestors } from "../app/planet/terrain/PlanetTerrain";
import { neighbourTile, parentTile } from "../app/planet/math";

const MARS_REFERENCE_RADIUS_M = 3_389_500;

describe("terrain worker geometry", () => {
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
});
