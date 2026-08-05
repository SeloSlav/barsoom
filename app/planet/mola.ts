import { TERRAIN_CONFIG } from "./constants";
import { bilinearSample, clamp, directionToFaceUv, tileKeyToString } from "./math";
import type { CubeFace, TileKey, Vec3 } from "./types";

const FACE_INDEX: Record<CubeFace, number> = {
  px: 0,
  nx: 1,
  py: 2,
  ny: 3,
  pz: 4,
  nz: 5,
};

export type MolaTileData = {
  key: TileKey;
  gridSize: number;
  heightsM: Int16Array;
  areoidM: Int16Array;
  minHeightM: number;
  maxHeightM: number;
  minAreoidM: number;
  maxAreoidM: number;
  bytes: number;
};

type MolaManifest = {
  format: string;
  version: number;
  gridSize: number;
  maxLod: number;
  source: Record<string, unknown>;
  tiles: Record<string, { path: string; bytes: number; crc32: string; sha256: string }>;
};

export function versionedMolaAssetUrl(path: string, sha256: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}revision=${encodeURIComponent(sha256.slice(0, 20))}`;
}

export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function decodeMolaTile(buffer: ArrayBuffer, expected?: TileKey): MolaTileData {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 24) throw new Error("MOLA tile is truncated");
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "MOL2") {
    throw new Error("MOLA tile magic is invalid");
  }
  const view = new DataView(buffer);
  const version = view.getUint8(4);
  if (version !== 1) throw new Error(`Unsupported MOLA tile version ${version}`);
  const gridSize = view.getUint8(5);
  const faceIndex = view.getUint8(6);
  const face = (Object.keys(FACE_INDEX) as CubeFace[]).find(
    (candidate) => FACE_INDEX[candidate] === faceIndex,
  );
  if (!face) throw new Error(`Invalid cube face index ${faceIndex}`);
  const key: TileKey = {
    face,
    lod: view.getUint8(7),
    x: view.getUint16(8, true),
    y: view.getUint16(10, true),
  };
  if (expected && tileKeyToString(key) !== tileKeyToString(expected)) {
    throw new Error(`MOLA tile key mismatch: wanted ${tileKeyToString(expected)}`);
  }
  const count = gridSize * gridSize;
  const expectedBytes = 24 + count * 4;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`MOLA tile byte length is ${bytes.byteLength}; expected ${expectedBytes}`);
  }
  const payloadCrc = view.getUint32(20, true);
  const actualCrc = crc32(bytes.subarray(24));
  if (actualCrc !== payloadCrc) throw new Error("MOLA tile checksum failed");
  const heightsM = new Int16Array(count);
  const areoidM = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    heightsM[index] = view.getInt16(24 + index * 2, true);
    areoidM[index] = view.getInt16(24 + count * 2 + index * 2, true);
  }
  return {
    key,
    gridSize,
    heightsM,
    areoidM,
    minHeightM: view.getInt16(12, true),
    maxHeightM: view.getInt16(14, true),
    minAreoidM: view.getInt16(16, true),
    maxAreoidM: view.getInt16(18, true),
    bytes: bytes.byteLength,
  };
}

export function assetAncestor(tile: TileKey, maxLod = TERRAIN_CONFIG.assetMaxLod): TileKey {
  if (tile.lod <= maxLod) return tile;
  const shift = tile.lod - maxLod;
  const divisor = 2 ** shift;
  return {
    face: tile.face,
    lod: maxLod,
    x: Math.floor(tile.x / divisor),
    y: Math.floor(tile.y / divisor),
  };
}

export function sampleMolaTile(tile: MolaTileData, direction: Vec3) {
  const mapped = directionToFaceUv(direction);
  if (mapped.face !== tile.key.face) return null;
  const count = 2 ** tile.key.lod;
  const tileU = ((mapped.u + 1) * 0.5) * count - tile.key.x;
  const tileV = ((mapped.v + 1) * 0.5) * count - tile.key.y;
  if (tileU < -1e-5 || tileV < -1e-5 || tileU > 1.00001 || tileV > 1.00001) {
    return null;
  }
  const x = clamp(tileU, 0, 1) * (tile.gridSize - 1);
  const y = clamp(tileV, 0, 1) * (tile.gridSize - 1);
  return {
    radiusHeightM: bilinearSample(tile.heightsM, tile.gridSize, tile.gridSize, x, y),
    areoidHeightM: bilinearSample(tile.areoidM, tile.gridSize, tile.gridSize, x, y),
  };
}

export class MolaTileLoader {
  private manifestPromise: Promise<MolaManifest> | null = null;
  private readonly cache = new Map<string, MolaTileData>();
  private readonly pending = new Map<string, Promise<MolaTileData>>();
  private readonly failures = new Set<string>();

  get cacheBytes() {
    let bytes = 0;
    for (const tile of this.cache.values()) bytes += tile.bytes;
    return bytes;
  }

  get loadingCount() {
    return this.pending.size;
  }

  private manifest() {
    this.manifestPromise ??= fetch("/data/mola/manifest.json", { cache: "no-cache" }).then(async (response) => {
      if (!response.ok) throw new Error(`MOLA manifest request failed (${response.status})`);
      const manifest = (await response.json()) as MolaManifest;
      if (manifest.format !== "barsoom-mola-cubesphere" || manifest.version !== 1) {
        throw new Error("Unsupported MOLA manifest");
      }
      return manifest;
    });
    return this.manifestPromise;
  }

  async load(tileInput: TileKey): Promise<MolaTileData> {
    const tile = assetAncestor(tileInput);
    const key = tileKeyToString(tile);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const request = this.loadUncached(tile).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async loadUncached(tile: TileKey): Promise<MolaTileData> {
    const key = tileKeyToString(tile);
    try {
      const manifest = await this.manifest();
      const entry = manifest.tiles[key];
      if (!entry) throw new Error(`MOLA asset is missing from manifest: ${key}`);
      const response = await fetch(versionedMolaAssetUrl(entry.path, entry.sha256), { cache: "force-cache" });
      if (!response.ok) throw new Error(`MOLA tile request failed (${response.status})`);
      const decoded = decodeMolaTile(await response.arrayBuffer(), tile);
      this.cache.set(key, decoded);
      this.trim();
      return decoded;
    } catch (error) {
      if (!this.failures.has(key)) {
        this.failures.add(key);
        console.warn(`[MOLA] ${key} unavailable; using the nearest parent`, error);
      }
      if (tile.lod > 0) {
        const parent: TileKey = {
          face: tile.face,
          lod: tile.lod - 1,
          x: Math.floor(tile.x / 2),
          y: Math.floor(tile.y / 2),
        };
        return this.load(parent);
      }
      return {
        key: tile,
        gridSize: 2,
        heightsM: new Int16Array(4),
        areoidM: new Int16Array(4),
        minHeightM: 0,
        maxHeightM: 0,
        minAreoidM: 0,
        maxAreoidM: 0,
        bytes: 16,
      };
    }
  }

  private trim() {
    while (this.cache.size > TERRAIN_CONFIG.molaCacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  sampleCached(direction: Vec3) {
    const mapped = directionToFaceUv(direction);
    for (let lod = TERRAIN_CONFIG.assetMaxLod; lod >= 0; lod -= 1) {
      const count = 2 ** lod;
      const key: TileKey = {
        face: mapped.face,
        lod,
        x: clamp(Math.floor(((mapped.u + 1) * 0.5) * count), 0, count - 1),
        y: clamp(Math.floor(((mapped.v + 1) * 0.5) * count), 0, count - 1),
      };
      const tile = this.cache.get(tileKeyToString(key));
      if (tile) return sampleMolaTile(tile, direction);
    }
    return null;
  }

  prefetchDirection(direction: Vec3) {
    const mapped = directionToFaceUv(direction);
    const lod = TERRAIN_CONFIG.assetMaxLod;
    const count = 2 ** lod;
    return this.load({
      face: mapped.face,
      lod,
      x: clamp(Math.floor(((mapped.u + 1) * 0.5) * count), 0, count - 1),
      y: clamp(Math.floor(((mapped.v + 1) * 0.5) * count), 0, count - 1),
    });
  }
}
