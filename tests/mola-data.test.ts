import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { directionToTile, faceUvToDirection, latLonElevationToCartesian, tileKeyToString } from "../app/planet/math";
import { decodeMolaTile, sampleMolaTile } from "../app/planet/mola";
import { decodePdsInt16Sample } from "../app/planet/pds";
import type { TileKey, Vec3 } from "../app/planet/types";

async function loadTile(key: TileKey) {
  const file = await readFile(path.join(process.cwd(), "public", "data", "mola", key.face, String(key.lod), String(key.x), `${key.y}.bin`));
  const arrayBuffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  return decodeMolaTile(arrayBuffer, key);
}

async function sampleGlobal(direction: Vec3) {
  const key = directionToTile(direction, 4);
  const tile = await loadTile(key);
  const sample = sampleMolaTile(tile, direction);
  if (!sample) throw new Error(`Direction did not map into ${tileKeyToString(key)}`);
  return { ...sample, topographyM: sample.radiusHeightM - sample.areoidHeightM };
}

describe("MOLA decoding and global terrain coverage", () => {
  it("decodes signed, scaled big-endian PDS values", () => {
    const bytes = new Uint8Array([0xff, 0x9c, 0x01, 0xf4]);
    const encoding = { sampleType: "MSB_INTEGER" as const, sampleBits: 16 as const, offset: 3_396_000, scalingFactor: 1 };
    expect(decodePdsInt16Sample(bytes, 0, encoding)).toBe(3_395_900);
    expect(decodePdsInt16Sample(bytes, 1, encoding)).toBe(3_396_500);
  });

  it("ships all 2,046 global cube-sphere base tiles with validation metadata", async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), "public/data/mola/manifest.json"), "utf8"));
    expect(manifest.format).toBe("barsoom-mola-cubesphere");
    expect(manifest.source.radiusProductId).toBe("MEGR90N000EB.IMG");
    expect(manifest.source.areoidProductId).toBe("MEGA90N000EB.IMG");
    expect(manifest.gridSize).toBe(65);
    expect(manifest.maxLod).toBe(4);
    expect(Object.keys(manifest.tiles)).toHaveLength(2_046);
    expect(Object.values(manifest.tiles).every((entry: any) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
  });

  it("matches every same-face tile border sample exactly", async () => {
    const left = await loadTile({ face: "px", lod: 2, x: 1, y: 2 });
    const right = await loadTile({ face: "px", lod: 2, x: 2, y: 2 });
    for (let row = 0; row < left.gridSize; row += 1) {
      expect(left.heightsM[row * left.gridSize + left.gridSize - 1]).toBe(right.heightsM[row * right.gridSize]);
      expect(left.areoidM[row * left.gridSize + left.gridSize - 1]).toBe(right.areoidM[row * right.gridSize]);
    }
  });

  it("matches cross-face cube borders without cracks", async () => {
    const px = await loadTile({ face: "px", lod: 0, x: 0, y: 0 });
    const nz = await loadTile({ face: "nz", lod: 0, x: 0, y: 0 });
    for (let row = 0; row < px.gridSize; row += 1) {
      expect(px.heightsM[row * px.gridSize + px.gridSize - 1]).toBe(nz.heightsM[row * nz.gridSize]);
      expect(px.areoidM[row * px.gridSize + px.gridSize - 1]).toBe(nz.areoidM[row * nz.gridSize]);
    }
  });

  it("retains the real elevation signatures of major Martian features", async () => {
    const olympus = await sampleGlobal(latLonElevationToCartesian(18.65, -133.8, 0, 1));
    const hellas = await sampleGlobal(latLonElevationToCartesian(-42.4, 70.5, 0, 1));
    const valles = await sampleGlobal(latLonElevationToCartesian(-13.9, -59.2, 0, 1));
    expect(olympus.topographyM).toBeGreaterThan(12_000);
    expect(hellas.topographyM).toBeLessThan(-5_000);
    expect(valles.topographyM).toBeLessThan(2_000);
  });

  it("samples the same physical edge direction from adjacent root products", async () => {
    const directionA = faceUvToDirection("px", 1, -0.36);
    const directionB = faceUvToDirection("nz", -1, -0.36);
    const [a, b] = await Promise.all([sampleGlobal(directionA), sampleGlobal(directionB)]);
    expect(a.radiusHeightM).toBeCloseTo(b.radiusHeightM, 8);
    expect(a.areoidHeightM).toBeCloseTo(b.areoidHeightM, 8);
  });
});
