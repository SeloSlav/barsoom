import { describe, expect, it } from "vitest";
// The terrain worker is intentionally shipped as browser-ready JavaScript.
// @ts-expect-error It has no separate declaration file.
import { generateTerrainTile } from "../public/workers/terrain-worker.js";

const MARS_REFERENCE_RADIUS_M = 3_389_500;

describe("terrain worker geometry", () => {
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
});
