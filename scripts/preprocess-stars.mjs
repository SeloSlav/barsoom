#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const input = process.argv[2];
const outputDir = process.argv[3] ?? "public/data/stars";
if (!input) throw new Error("Usage: preprocess-stars path/to/hygdata_v41.csv [public/data/stars]");

function csvRow(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
    } else current += character;
  }
  values.push(current);
  return values;
}

const csv = await readFile(input, "utf8");
const lines = csv.split(/\r?\n/);
const headers = csvRow(lines.shift());
const index = Object.fromEntries(headers.map((header, column) => [header, column]));
const stars = [];
const names = {};
for (const line of lines) {
  if (!line) continue;
  const row = csvRow(line);
  const magnitude = Number(row[index.mag]);
  const raHours = Number(row[index.ra]);
  const decDeg = Number(row[index.dec]);
  if (!Number.isFinite(magnitude) || magnitude > 6.25 || !Number.isFinite(raHours) || !Number.isFinite(decDeg)) continue;
  const hip = Number(row[index.hip]) || 0;
  const colourIndex = Number(row[index.ci]);
  const proper = row[index.proper] ?? "";
  stars.push({
    raDeg: raHours * 15,
    decDeg,
    magnitude,
    colourIndex: Number.isFinite(colourIndex) ? colourIndex : 0.65,
    hip,
  });
  if (proper && magnitude <= 2.5) names[String(hip)] = proper;
}
stars.sort((a, b) => a.magnitude - b.magnitude || a.hip - b.hip);

const recordBytes = 16;
const output = Buffer.alloc(12 + stars.length * recordBytes);
output.write("STAR", 0, "ascii");
output.writeUInt16LE(1, 4);
output.writeUInt16LE(recordBytes, 6);
output.writeUInt32LE(stars.length, 8);
stars.forEach((star, starIndex) => {
  const offset = 12 + starIndex * recordBytes;
  output.writeFloatLE(star.raDeg, offset);
  output.writeFloatLE(star.decDeg, offset + 4);
  output.writeInt16LE(Math.round(star.magnitude * 100), offset + 8);
  output.writeInt16LE(Math.round(star.colourIndex * 1000), offset + 10);
  output.writeUInt32LE(star.hip, offset + 12);
});

await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "hipparcos-bright.bin"), output);
await writeFile(path.join(outputDir, "bright-names.json"), `${JSON.stringify(names, null, 2)}\n`);
await writeFile(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify({
    format: "barsoom-bright-star-catalogue",
    version: 1,
    count: stars.length,
    limitingMagnitude: 6.25,
    recordBytes,
    sha256: createHash("sha256").update(output).digest("hex"),
    source: {
      catalogue: "HYG Database 4.1 (Hipparcos, Yale Bright Star, Gliese)",
      sourceUrl: "https://github.com/astronexus/HYG-Database/tree/main/hyg/CURRENT",
      license: "CC BY-SA 4.0",
      coordinates: "equatorial J2000",
    },
  }, null, 2)}\n`,
);
console.log(`Wrote ${stars.length} stars (${output.byteLength} bytes) to ${outputDir}`);

