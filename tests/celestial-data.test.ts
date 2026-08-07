import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { calculateMarsMoons, calculateMarsOrbiters, calculateMarsSky, chooseOrbitalSurveyComposition, inertialToMarsFixedVector, marsOrientationMatrix, writeMarsOrbiterOrbitPath } from "../app/planet/ephemeris";
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
    expect(sky.sunAngularRadiusRad).toBeGreaterThan(0.0025);
    expect(sky.sunAngularRadiusRad).toBeLessThan(0.0037);
    expect(sky.bodies.map((body) => body.name)).toEqual([
      "Mercury", "Venus", "Earth", "Jupiter", "Saturn", "Uranus", "Neptune",
    ]);
    expect(sky.moons.map((moon) => moon.name)).toEqual(["Phobos", "Deimos"]);
    expect(sky.orbiters.map((orbiter) => orbiter.shortName)).toEqual(["ODYSSEY", "MRO", "TGO"]);
    for (const body of sky.bodies) {
      expect(length3(body.direction)).toBeCloseTo(1, 10);
      expect(body.distanceAu).toBeGreaterThan(0);
      expect(body.angularRadiusRad).toBeGreaterThan(0);
      expect(Number.isFinite(body.magnitude)).toBe(true);
    }
    const later = calculateMarsSky(new Date(utc.getTime() + 3_600_000));
    expect(dot3(sky.sunDirection, later.sunDirection)).toBeLessThan(0.9999);

    const composition = chooseOrbitalSurveyComposition(sky);
    expect(dot3(composition.focusDirection, sky.sunDirection)).toBeGreaterThanOrEqual(0.28);
    if (composition.featuredBody) {
      const body = sky.bodies.find((candidate) => candidate.name === composition.featuredBody)!;
      const viewCenter = { x: -composition.focusDirection.x, y: -composition.focusDirection.y, z: -composition.focusDirection.z };
      const offsetDegrees = Math.acos(dot3(body.direction, viewCenter)) * 180 / Math.PI;
      expect(offsetDegrees).toBeCloseTo(18, 8);
    }
  });

  it("propagates current Mars spacecraft from NASA/JPL Horizons elements", () => {
    const epoch = new Date("2026-08-06T23:58:50.816Z");
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const initial = calculateMarsOrbiters(epoch, identity);
    const later = calculateMarsOrbiters(new Date(epoch.getTime() + 600_000), identity);
    expect(initial.map((orbiter) => orbiter.name)).toEqual([
      "Mars Odyssey",
      "Mars Reconnaissance Orbiter",
      "Trace Gas Orbiter",
    ]);
    for (let index = 0; index < initial.length; index += 1) {
      const orbiter = initial[index];
      expect(length3(orbiter.orbitNormal)).toBeCloseTo(1, 12);
      expect(Math.abs(dot3(orbiter.positionM, orbiter.orbitNormal))).toBeLessThan(2);
      expect(orbiter.altitudeM).toBeGreaterThan(200_000);
      expect(orbiter.altitudeM).toBeLessThan(500_000);
      expect(orbiter.speedMps).toBeGreaterThan(3_200);
      expect(orbiter.speedMps).toBeLessThan(3_600);
      const motion = dot3(orbiter.positionM, later[index].positionM)
        / (length3(orbiter.positionM) * length3(later[index].positionM));
      expect(motion).toBeLessThan(0.9);

      const orbitPath = new Float32Array(193 * 3);
      writeMarsOrbiterOrbitPath(orbiter, identity, orbitPath);
      expect(Math.hypot(
        orbitPath[0] - orbitPath[orbitPath.length - 3],
        orbitPath[1] - orbitPath[orbitPath.length - 2],
        orbitPath[2] - orbitPath[orbitPath.length - 1],
      )).toBeLessThan(1);
    }
  });

  it("advances physical, inclined Mars moon orbits on the simulation clock", () => {
    const epoch = new Date("2026-08-05T23:58:50.816Z");
    const initial = calculateMarsMoons(epoch);
    const inertial = calculateMarsMoons(epoch, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const oneHour = calculateMarsMoons(new Date(epoch.getTime() + 3_600_000));
    expect(initial[0].semiAxesM).toEqual([13_400, 11_200, 9_200]);
    expect(initial[1].semiAxesM).toEqual([7_500, 6_100, 5_200]);
    expect(length3(initial[0].positionM)).toBeGreaterThan(9_230_000);
    expect(length3(initial[0].positionM)).toBeLessThan(9_525_000);
    expect(length3(initial[1].positionM)).toBeGreaterThan(23_450_000);
    expect(length3(initial[1].positionM)).toBeLessThan(23_467_000);
    const horizonsReferenceM = [
      { x: 5_161_591.815, y: 7_691_347.656, z: 1_235_648.264 },
      { x: 20_199_427.65, y: 11_118_183.75, z: -4_312_025.593 },
    ];
    for (let index = 0; index < inertial.length; index += 1) {
      expect(Math.hypot(
        inertial[index].positionM.x - horizonsReferenceM[index].x,
        inertial[index].positionM.y - horizonsReferenceM[index].y,
        inertial[index].positionM.z - horizonsReferenceM[index].z,
      )).toBeLessThan(2);
    }
    for (const moon of initial) {
      expect(length3(moon.orbitNormal)).toBeCloseTo(1, 12);
      expect(dot3(moon.positionM, moon.orbitNormal)).toBeCloseTo(0, -3);
    }
    const phobosMotion = dot3(initial[0].positionM, oneHour[0].positionM)
      / (length3(initial[0].positionM) * length3(oneHour[0].positionM));
    const deimosMotion = dot3(initial[1].positionM, oneHour[1].positionM)
      / (length3(initial[1].positionM) * length3(oneHour[1].positionM));
    expect(phobosMotion).toBeLessThan(deimosMotion);
    // In the Mars-fixed renderer this is roughly 32 degrees eastward for
    // Phobos and 2.7 degrees westward for Deimos in one hour.
    expect(phobosMotion).toBeLessThan(0.9);
    expect(deimosMotion).toBeGreaterThan(0.995);
  });
});
