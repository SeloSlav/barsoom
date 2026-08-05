import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { calculateMarsSky, inertialToMarsFixedVector, marsOrientationMatrix } from "../app/planet/ephemeris";
import { dot3, length3 } from "../app/planet/math";

describe("embedded astronomical data", () => {
  it("ships a validated, magnitude-sorted HYG/Hipparcos binary catalogue", async () => {
    const directory = path.join(process.cwd(), "public/data/stars");
    const [file, manifestText] = await Promise.all([
      readFile(path.join(directory, "hipparcos-bright.bin")),
      readFile(path.join(directory, "manifest.json"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText);
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    expect(file.subarray(0, 4).toString("ascii")).toBe("STAR");
    expect(view.getUint16(4, true)).toBe(1);
    expect(view.getUint16(6, true)).toBe(16);
    expect(view.getUint32(8, true)).toBe(6_682);
    expect(file.byteLength).toBe(12 + 6_682 * 16);
    expect(createHash("sha256").update(file).digest("hex")).toBe(manifest.sha256);
    let previousMagnitude = -Infinity;
    let colouredStars = 0;
    for (let index = 0; index < 6_682; index += 1) {
      const offset = 12 + index * 16;
      const rightAscension = view.getFloat32(offset, true);
      const declination = view.getFloat32(offset + 4, true);
      const magnitude = view.getInt16(offset + 8, true) / 100;
      const colourIndex = view.getInt16(offset + 10, true) / 1000;
      expect(rightAscension).toBeGreaterThanOrEqual(0);
      expect(rightAscension).toBeLessThan(360);
      expect(declination).toBeGreaterThanOrEqual(-90);
      expect(declination).toBeLessThanOrEqual(90);
      expect(magnitude).toBeGreaterThanOrEqual(previousMagnitude);
      expect(magnitude).toBeLessThanOrEqual(6.25);
      if (Math.abs(colourIndex) > 0.02) colouredStars += 1;
      previousMagnitude = magnitude;
    }
    expect(colouredStars).toBeGreaterThan(5_000);
  });

  it("produces an orthonormal Mars body frame and deterministic Mars-centred ephemerides", () => {
    const utc = new Date("2032-04-17T05:23:11.000Z");
    const matrix = marsOrientationMatrix(utc);
    const rows = [
      { x: matrix[0], y: matrix[1], z: matrix[2] },
      { x: matrix[3], y: matrix[4], z: matrix[5] },
      { x: matrix[6], y: matrix[7], z: matrix[8] },
    ];
    for (const row of rows) expect(length3(row)).toBeCloseTo(1, 12);
    expect(dot3(rows[0], rows[1])).toBeCloseTo(0, 12);
    expect(dot3(rows[0], rows[2])).toBeCloseTo(0, 12);
    expect(dot3(rows[1], rows[2])).toBeCloseTo(0, 12);
    const transformed = inertialToMarsFixedVector({ x: 0.3, y: -0.4, z: 0.5 }, matrix);
    expect(length3(transformed)).toBeCloseTo(Math.hypot(0.3, 0.4, 0.5), 12);

    const sky = calculateMarsSky(utc);
    expect(calculateMarsSky(new Date(utc)).sunDirection).toEqual(sky.sunDirection);
    expect(length3(sky.sunDirection)).toBeCloseTo(1, 12);
    expect(sky.bodies.map((body) => body.name)).toEqual([
      "Mercury", "Venus", "Earth", "Jupiter", "Saturn", "Uranus", "Neptune", "Phobos", "Deimos",
    ]);
    for (const body of sky.bodies) {
      expect(length3(body.direction)).toBeCloseTo(1, 10);
      expect(body.distanceAu).toBeGreaterThan(0);
      expect(body.angularRadiusRad).toBeGreaterThan(0);
      expect(Number.isFinite(body.magnitude)).toBe(true);
    }
    const later = calculateMarsSky(new Date(utc.getTime() + 3_600_000));
    expect(dot3(sky.sunDirection, later.sunDirection)).toBeLessThan(0.9999);
  });
});
