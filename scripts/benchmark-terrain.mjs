#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { generateTerrainTile } from "../public/workers/terrain-worker.js";

const sourceKey = { face: "px", lod: 4, x: 8, y: 8 };
const file = await readFile(new URL("../public/data/mola/px/4/8/8.bin", import.meta.url));
const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
if (file.subarray(0, 4).toString("ascii") !== "MOL2") throw new Error("Benchmark MOLA tile has invalid magic");
const gridSize = view.getUint8(5);
const count = gridSize * gridSize;
const heightsM = new Int16Array(count);
const areoidM = new Int16Array(count);
for (let index = 0; index < count; index += 1) {
  heightsM[index] = view.getInt16(24 + index * 2, true);
  areoidM[index] = view.getInt16(24 + count * 2 + index * 2, true);
}
const base = { key: sourceKey, gridSize, heightsM, areoidM };
const renderLod = 12;
const subdivision = 2 ** (renderLod - sourceKey.lod);

function job(index) {
  return {
    jobId: index,
    key: {
      face: sourceKey.face,
      lod: renderLod,
      x: sourceKey.x * subdivision + (index * 37) % subdivision,
      y: sourceKey.y * subdivision + (index * 71) % subdivision,
    },
    base,
    segments: 24,
    skirtM: 140,
  };
}

for (let index = 0; index < 12; index += 1) generateTerrainTile(job(index));
const durations = [];
let outputBytes = 0;
for (let index = 0; index < 120; index += 1) {
  const started = performance.now();
  const generated = generateTerrainTile(job(index));
  durations.push(performance.now() - started);
  if (index === 0) {
    outputBytes = generated.positions.byteLength + generated.normals.byteLength +
      generated.planetDirections.byteLength + generated.elevations.byteLength +
      generated.areoidElevations.byteLength + generated.morphDelta.byteLength +
      generated.normalMorphDelta.byteLength +
      generated.tileUv.byteLength + generated.surface.byteLength + generated.indices.byteLength;
  }
}
durations.sort((a, b) => a - b);
const percentile = (p) => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))];
const result = {
  runtime: `${process.platform} / Node ${process.version}`,
  samples: durations.length,
  topology: "24x24 cells plus skirts",
  outputBytesPerTile: outputBytes,
  meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
  medianMs: percentile(0.5),
  p95Ms: percentile(0.95),
  maximumMs: durations.at(-1),
  twoWorkerP95ThroughputTilesPerSecond: 2_000 / percentile(0.95),
};
console.log(JSON.stringify(result, null, 2));
