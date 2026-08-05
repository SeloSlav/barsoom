#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MARS_REFERENCE_RADIUS_M = 3_389_500;
const FACES = ["px", "nx", "py", "ny", "pz", "nz"];
const PDS_MEGDR_ROOT = "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x";

function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    result[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function metadata(label) {
  const numeric = (name) => {
    const match = label.match(new RegExp(`\\b${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, "m"));
    if (!match) throw new Error(`PDS label does not contain ${name}`);
    return Number(match[1]);
  };
  const text = (name) => {
    const match = label.match(new RegExp(`\\b${name}\\s*=\\s*"?([^"\\r\\n]+)`, "m"));
    return match?.[1]?.trim() ?? null;
  };
  return {
    lines: numeric("LINES"),
    samples: numeric("LINE_SAMPLES"),
    bits: numeric("SAMPLE_BITS"),
    offset: numeric("OFFSET"),
    scale: numeric("SCALING_FACTOR"),
    resolution: numeric("MAP_RESOLUTION"),
    sampleType: text("SAMPLE_TYPE"),
    productId: text("PRODUCT_ID"),
    productVersion: text("PRODUCT_VERSION_ID"),
    dataSetId: text("DATA_SET_ID"),
    coordinateSystem: text("COORDINATE_SYSTEM_NAME"),
    longitudeDirection: text("POSITIVE_LONGITUDE_DIRECTION"),
  };
}

function normalize({ x, y, z }) {
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}

function faceDirection(face, u, v) {
  switch (face) {
    case "px": return normalize({ x: 1, y: v, z: -u });
    case "nx": return normalize({ x: -1, y: v, z: u });
    case "py": return normalize({ x: u, y: 1, z: -v });
    case "ny": return normalize({ x: u, y: -1, z: v });
    case "pz": return normalize({ x: u, y: v, z: 1 });
    case "nz": return normalize({ x: -u, y: v, z: -1 });
  }
}

function readSource(raw, info, row, column) {
  const wrappedColumn = ((column % info.samples) + info.samples) % info.samples;
  const clampedRow = Math.max(0, Math.min(info.lines - 1, row));
  const byteOffset = (clampedRow * info.samples + wrappedColumn) * 2;
  const sample = raw.readInt16BE(byteOffset);
  return sample * info.scale + info.offset;
}

function sampleSource(raw, info, direction) {
  const latitude = Math.asin(Math.max(-1, Math.min(1, direction.y))) * 180 / Math.PI;
  let longitude = Math.atan2(direction.z, direction.x) * 180 / Math.PI;
  if (longitude < 0) longitude += 360;
  const sourceX = longitude * info.resolution - 0.5;
  const sourceY = (90 - latitude) * info.resolution - 0.5;
  const x0 = Math.floor(sourceX);
  const y0 = Math.floor(sourceY);
  const tx = sourceX - x0;
  const ty = sourceY - y0;
  const a = readSource(raw, info, y0, x0) * (1 - tx) + readSource(raw, info, y0, x0 + 1) * tx;
  const b = readSource(raw, info, y0 + 1, x0) * (1 - tx) + readSource(raw, info, y0 + 1, x0 + 1) * tx;
  return a * (1 - ty) + b * ty;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function productUrl(productId, resolution) {
  const directory = `meg${String(resolution).padStart(3, "0")}`;
  return `${PDS_MEGDR_ROOT}/${directory}/${productId.toLowerCase()}`;
}

const options = argumentsFrom(process.argv.slice(2));
const radiusPath = options.radius;
const areoidPath = options.areoid;
const outputPath = options.out ?? "public/data/mola";
const maxLod = Number(options["max-lod"] ?? 4);
const gridSize = Number(options.grid ?? 65);
if (!radiusPath || !areoidPath) {
  throw new Error("Usage: preprocess-mola --radius path/to/megr...img --areoid path/to/mega...img [--out public/data/mola]");
}
if (!Number.isInteger(maxLod) || maxLod < 0 || maxLod > 16) throw new Error("Max LOD must be an integer between 0 and 16");
if (!Number.isInteger(gridSize) || gridSize < 2 || gridSize > 255) throw new Error("Grid size must be an integer between 2 and 255");

const radiusLabelPath = radiusPath.replace(/\.img$/i, ".lbl");
const areoidLabelPath = areoidPath.replace(/\.img$/i, ".lbl");
const [radiusRaw, areoidRaw, radiusLabel, areoidLabel] = await Promise.all([
  readFile(radiusPath),
  readFile(areoidPath),
  readFile(radiusLabelPath, "utf8"),
  readFile(areoidLabelPath, "utf8"),
]);
const radiusInfo = metadata(radiusLabel);
const areoidInfo = metadata(areoidLabel);
for (const info of [radiusInfo, areoidInfo]) {
  if (info.bits !== 16 || info.sampleType !== "MSB_INTEGER") {
    throw new Error(`Unsupported PDS encoding: ${info.sampleType}/${info.bits}`);
  }
  if (info.longitudeDirection !== "EAST") throw new Error("Only east-positive longitude is supported");
  if (info.lines * info.samples * 2 !== (info === radiusInfo ? radiusRaw : areoidRaw).byteLength) {
    throw new Error("PDS image byte length does not match its label");
  }
}
for (const field of ["lines", "samples", "resolution", "coordinateSystem", "longitudeDirection"]) {
  if (radiusInfo[field] !== areoidInfo[field]) throw new Error(`Radius and areoid metadata disagree on ${field}`);
}

await mkdir(outputPath, { recursive: true });
const manifest = {
  format: "barsoom-mola-cubesphere",
  version: 1,
  generatedUtc: new Date(0).toISOString(),
  referenceRadiusM: MARS_REFERENCE_RADIUS_M,
  gridSize,
  maxLod,
  source: {
    dataSetId: radiusInfo.dataSetId,
    radiusProductId: radiusInfo.productId,
    areoidProductId: areoidInfo.productId,
    productVersion: radiusInfo.productVersion,
    coordinateSystem: radiusInfo.coordinateSystem,
    positiveLongitudeDirection: radiusInfo.longitudeDirection,
    sourceResolutionPixelsPerDegree: radiusInfo.resolution,
    sourceLines: radiusInfo.lines,
    sourceLineSamples: radiusInfo.samples,
    sampleType: radiusInfo.sampleType,
    sampleBits: radiusInfo.bits,
    scalingFactor: radiusInfo.scale,
    offsetM: radiusInfo.offset,
    radiusSha256: createHash("sha256").update(radiusRaw).digest("hex"),
    areoidSha256: createHash("sha256").update(areoidRaw).digest("hex"),
    radiusLabelSha256: createHash("sha256").update(radiusLabel).digest("hex"),
    areoidLabelSha256: createHash("sha256").update(areoidLabel).digest("hex"),
    radiusUrl: productUrl(radiusInfo.productId, radiusInfo.resolution),
    areoidUrl: productUrl(areoidInfo.productId, areoidInfo.resolution),
  },
  settings: {
    projection: "normalized cube sphere",
    interpolation: "bilinear in source simple-cylindrical grid",
    heightEncoding: "little-endian signed int16 metres from 3389500 m reference radius",
    areoidEncoding: "little-endian signed int16 metres from 3389500 m reference radius",
    borders: "inclusive shared samples",
  },
  tiles: {},
};

for (let lod = 0; lod <= maxLod; lod += 1) {
  const count = 2 ** lod;
  for (let faceIndex = 0; faceIndex < FACES.length; faceIndex += 1) {
    const face = FACES[faceIndex];
    for (let y = 0; y < count; y += 1) {
      for (let x = 0; x < count; x += 1) {
        const cellCount = gridSize * gridSize;
        const heights = new Int16Array(cellCount);
        const areoids = new Int16Array(cellCount);
        let minHeight = Infinity;
        let maxHeight = -Infinity;
        let minAreoid = Infinity;
        let maxAreoid = -Infinity;
        for (let row = 0; row < gridSize; row += 1) {
          const tileV = row / (gridSize - 1);
          const v = -1 + 2 * (y + tileV) / count;
          for (let column = 0; column < gridSize; column += 1) {
            const tileU = column / (gridSize - 1);
            const u = -1 + 2 * (x + tileU) / count;
            const direction = faceDirection(face, u, v);
            const height = Math.round(sampleSource(radiusRaw, radiusInfo, direction) - MARS_REFERENCE_RADIUS_M);
            const areoid = Math.round(sampleSource(areoidRaw, areoidInfo, direction) - MARS_REFERENCE_RADIUS_M);
            const index = row * gridSize + column;
            heights[index] = Math.max(-32768, Math.min(32767, height));
            areoids[index] = Math.max(-32768, Math.min(32767, areoid));
            minHeight = Math.min(minHeight, heights[index]);
            maxHeight = Math.max(maxHeight, heights[index]);
            minAreoid = Math.min(minAreoid, areoids[index]);
            maxAreoid = Math.max(maxAreoid, areoids[index]);
          }
        }
        const headerBytes = 24;
        const output = Buffer.alloc(headerBytes + cellCount * 4);
        output.write("MOL2", 0, "ascii");
        output.writeUInt8(1, 4);
        output.writeUInt8(gridSize, 5);
        output.writeUInt8(faceIndex, 6);
        output.writeUInt8(lod, 7);
        output.writeUInt16LE(x, 8);
        output.writeUInt16LE(y, 10);
        output.writeInt16LE(minHeight, 12);
        output.writeInt16LE(maxHeight, 14);
        output.writeInt16LE(minAreoid, 16);
        output.writeInt16LE(maxAreoid, 18);
        for (let index = 0; index < cellCount; index += 1) {
          output.writeInt16LE(heights[index], headerBytes + index * 2);
          output.writeInt16LE(areoids[index], headerBytes + cellCount * 2 + index * 2);
        }
        const payloadCrc = crc32(output.subarray(headerBytes));
        output.writeUInt32LE(payloadCrc, 20);
        const relative = `${face}/${lod}/${x}/${y}.bin`;
        const target = path.join(outputPath, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, output);
        manifest.tiles[`${face}/${lod}/${x}/${y}`] = {
          path: `/data/mola/${relative.replaceAll("\\", "/")}`,
          bytes: output.byteLength,
          crc32: payloadCrc.toString(16).padStart(8, "0"),
          sha256: createHash("sha256").update(output).digest("hex"),
        };
      }
    }
  }
}

await writeFile(path.join(outputPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${Object.keys(manifest.tiles).length} deterministic MOLA cube-sphere tiles to ${outputPath}`);
