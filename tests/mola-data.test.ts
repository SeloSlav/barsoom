import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { directionToTile, faceUvToDirection, latLonElevationToCartesian, neighbourTile, tileBounds, tileKeyToString } from "../app/planet/math";
import { decodeMolaTile, MolaTileLoader, sampleMolaTile, versionedMolaAssetUrl } from "../app/planet/mola";
import { decodePdsInt16Sample } from "../app/planet/pds";
import type { TileKey, Vec3 } from "../app/planet/types";

const FACES = ["px", "nx", "py", "ny", "pz", "nz"] as const;

function projectToFace(face: TileKey["face"], direction: Vec3) {
  const ax = Math.abs(direction.x);
  const ay = Math.abs(direction.y);
  const az = Math.abs(direction.z);
  switch (face) {
    case "px": return { u: -direction.z / ax, v: direction.y / ax };
    case "nx": return { u: direction.z / ax, v: direction.y / ax };
    case "py": return { u: direction.x / ay, v: -direction.z / ay };
    case "ny": return { u: direction.x / ay, v: direction.z / ay };
    case "pz": return { u: direction.x / az, v: direction.y / az };
    case "nz": return { u: -direction.x / az, v: direction.y / az };
  }
}

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
  it("fingerprints static terrain URLs so revised elevation data cannot stay cached", () => {
    expect(versionedMolaAssetUrl("/data/mola/px/4/1/2.bin", "abcdef0123456789abcdef"))
      .toBe("/data/mola/px/4/1/2.bin?revision=abcdef0123456789abcd");
    expect(versionedMolaAssetUrl("/tile?source=mola", "0123456789abcdef012345"))
      .toBe("/tile?source=mola&revision=0123456789abcdef0123");
  });
  it("decodes signed, scaled big-endian PDS values", () => {
    const bytes = new Uint8Array([0xff, 0x9c, 0x01, 0xf4]);
    const encoding = { sampleType: "MSB_INTEGER" as const, sampleBits: 16 as const, offset: 3_396_000, scalingFactor: 1 };
    expect(decodePdsInt16Sample(bytes, 0, encoding)).toBe(3_395_900);
    expect(decodePdsInt16Sample(bytes, 1, encoding)).toBe(3_396_500);
  });

  it("rejects corrupt payloads and recovers a missing tile through its nearest parent", async () => {
    const parentPath = path.join(process.cwd(), "public/data/mola/px/1/0/0.bin");
    const parentFile = await readFile(parentPath);
    const corrupt = new Uint8Array(parentFile);
    corrupt[corrupt.length - 1] ^= 0xff;
    expect(() => decodeMolaTile(corrupt.buffer.slice(corrupt.byteOffset, corrupt.byteOffset + corrupt.byteLength))).toThrow(/checksum/i);

    const originalFetch = globalThis.fetch;
    const parentBytes = parentFile.buffer.slice(parentFile.byteOffset, parentFile.byteOffset + parentFile.byteLength) as ArrayBuffer;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) {
        return new Response(JSON.stringify({
          format: "barsoom-mola-cubesphere",
          version: 1,
          gridSize: 65,
          maxLod: 4,
          source: {},
          tiles: { "px/1/0/0": { path: "/parent.bin", bytes: parentBytes.byteLength, crc32: "", sha256: "" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("/parent.bin?revision=")) return new Response(parentBytes.slice(0), { status: 200 });
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    try {
      const recovered = await new MolaTileLoader().load({ face: "px", lod: 2, x: 0, y: 0 });
      expect(recovered.key).toEqual({ face: "px", lod: 1, x: 0, y: 0 });
      expect(recovered.gridSize).toBe(65);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ships all 2,046 global cube-sphere base tiles with validation metadata", async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), "public/data/mola/manifest.json"), "utf8"));
    expect(manifest.format).toBe("barsoom-mola-cubesphere");
    expect(manifest.source.radiusProductId).toBe("MEGR90N000EB.IMG");
    expect(manifest.source.areoidProductId).toBe("MEGA90N000EB.IMG");
    expect(manifest.gridSize).toBe(65);
    expect(manifest.maxLod).toBe(4);
    expect(manifest.source).toMatchObject({
      positiveLongitudeDirection: "EAST",
      sourceLines: 2880,
      sourceLineSamples: 5760,
      sampleType: "MSB_INTEGER",
      sampleBits: 16,
      scalingFactor: 1,
      offsetM: 3_396_000,
    });
    for (const field of ["radiusSha256", "areoidSha256", "radiusLabelSha256", "areoidLabelSha256"]) {
      expect(manifest.source[field]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(manifest.tiles)).toHaveLength(2_046);
    expect(Object.values(manifest.tiles).every((entry) =>
      /^[0-9a-f]{64}$/.test((entry as { sha256: string }).sha256),
    )).toBe(true);
    const entries = Object.entries(manifest.tiles) as Array<[string, { path: string; bytes: number; sha256: string }]>;
    for (let offset = 0; offset < entries.length; offset += 64) {
      await Promise.all(entries.slice(offset, offset + 64).map(async ([key, entry]) => {
        const file = await readFile(path.join(process.cwd(), "public", entry.path));
        expect(file.byteLength, `${key} byte length`).toBe(entry.bytes);
        expect(createHash("sha256").update(file).digest("hex"), `${key} SHA-256`).toBe(entry.sha256);
        const expected = key.split("/");
        decodeMolaTile(
          file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
          { face: expected[0] as TileKey["face"], lod: Number(expected[1]), x: Number(expected[2]), y: Number(expected[3]) },
        );
      }));
    }
  });

  it("matches every same-face tile border sample exactly", async () => {
    const left = await loadTile({ face: "px", lod: 2, x: 1, y: 2 });
    const right = await loadTile({ face: "px", lod: 2, x: 2, y: 2 });
    for (let row = 0; row < left.gridSize; row += 1) {
      expect(left.heightsM[row * left.gridSize + left.gridSize - 1]).toBe(right.heightsM[row * right.gridSize]);
      expect(left.areoidM[row * left.gridSize + left.gridSize - 1]).toBe(right.areoidM[row * right.gridSize]);
    }
  });

  it("matches every LOD-4 sibling and cross-face border sample globally", async () => {
    const lod = 4;
    const count = 2 ** lod;
    const tiles = new Map<string, Awaited<ReturnType<typeof loadTile>>>();
    const keys: TileKey[] = [];
    for (const face of FACES) {
      for (let y = 0; y < count; y += 1) {
        for (let x = 0; x < count; x += 1) keys.push({ face, lod, x, y });
      }
    }
    for (let offset = 0; offset < keys.length; offset += 64) {
      const batch = keys.slice(offset, offset + 64);
      const loaded = await Promise.all(batch.map(loadTile));
      loaded.forEach((tile, index) => tiles.set(tileKeyToString(batch[index]), tile));
    }

    const assertSame = (a: number, b: number, context: string) => {
      if (a !== b) throw new Error(`${context}: ${a} != ${b}`);
    };
    for (const face of FACES) {
      for (let y = 0; y < count; y += 1) {
        for (let x = 0; x < count; x += 1) {
          const tile = tiles.get(tileKeyToString({ face, lod, x, y }))!;
          if (x + 1 < count) {
            const east = tiles.get(tileKeyToString({ face, lod, x: x + 1, y }))!;
            for (let sample = 0; sample < tile.gridSize; sample += 1) {
              const a = sample * tile.gridSize + tile.gridSize - 1;
              const b = sample * east.gridSize;
              assertSame(tile.heightsM[a], east.heightsM[b], `${face}/${x}/${y} east height ${sample}`);
              assertSame(tile.areoidM[a], east.areoidM[b], `${face}/${x}/${y} east areoid ${sample}`);
            }
          }
          if (y + 1 < count) {
            const south = tiles.get(tileKeyToString({ face, lod, x, y: y + 1 }))!;
            for (let sample = 0; sample < tile.gridSize; sample += 1) {
              const a = (tile.gridSize - 1) * tile.gridSize + sample;
              const b = sample;
              assertSame(tile.heightsM[a], south.heightsM[b], `${face}/${x}/${y} south height ${sample}`);
              assertSame(tile.areoidM[a], south.areoidM[b], `${face}/${x}/${y} south areoid ${sample}`);
            }
          }
        }
      }
    }

    for (const face of FACES) {
      for (const edge of ["north", "east", "south", "west"] as const) {
        for (let edgeTile = 0; edgeTile < count; edgeTile += 1) {
          const key: TileKey = edge === "north" || edge === "south"
            ? { face, lod, x: edgeTile, y: edge === "north" ? 0 : count - 1 }
            : { face, lod, x: edge === "west" ? 0 : count - 1, y: edgeTile };
          const adjacentKey = neighbourTile(key, edge);
          if (adjacentKey.face === face) continue;
          const tile = tiles.get(tileKeyToString(key))!;
          const adjacent = tiles.get(tileKeyToString(adjacentKey))!;
          const bounds = tileBounds(key);
          for (let sample = 0; sample < tile.gridSize; sample += 1) {
            const t = sample / (tile.gridSize - 1);
            const u = edge === "west" ? bounds.u0 : edge === "east" ? bounds.u1 : bounds.u0 + (bounds.u1 - bounds.u0) * t;
            const v = edge === "north" ? bounds.v0 : edge === "south" ? bounds.v1 : bounds.v0 + (bounds.v1 - bounds.v0) * t;
            const direction = faceUvToDirection(face, u, v);
            const mapped = projectToFace(adjacentKey.face, direction);
            const adjacentX = Math.round((((mapped.u + 1) * 0.5 * count) - adjacentKey.x) * (adjacent.gridSize - 1));
            const adjacentY = Math.round((((mapped.v + 1) * 0.5 * count) - adjacentKey.y) * (adjacent.gridSize - 1));
            const sourceX = edge === "west" ? 0 : edge === "east" ? tile.gridSize - 1 : sample;
            const sourceY = edge === "north" ? 0 : edge === "south" ? tile.gridSize - 1 : sample;
            const a = sourceY * tile.gridSize + sourceX;
            const b = adjacentY * adjacent.gridSize + adjacentX;
            const context = `${tileKeyToString(key)} ${edge} -> ${tileKeyToString(adjacentKey)} sample ${sample}`;
            assertSame(tile.heightsM[a], adjacent.heightsM[b], `${context} height`);
            assertSame(tile.areoidM[a], adjacent.areoidM[b], `${context} areoid`);
          }
        }
      }
    }
  }, 30_000);

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
