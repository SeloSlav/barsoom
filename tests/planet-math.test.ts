import { describe, expect, it } from "vitest";
import { MARS_REFERENCE_RADIUS_M, MAX_CAMERA_ALTITUDE_M, SURFACE_EYE_HEIGHT_M } from "../app/planet/constants";
import {
  cameraAltitudeAboveGround,
  cartesianToLatLonElevation,
  childTiles,
  directionToFaceUv,
  directionToTile,
  dot3,
  faceUvToDirection,
  latLonElevationToCartesian,
  length3,
  localEnuBasis,
  neighbourTile,
  nonlinearZoomAltitude,
  parentTile,
  raySphereIntersection,
  rayTerrainIntersection,
  snappedDirectionalShadowCenter,
  splitHighLow,
  surfaceNormalAndSlope,
  tileKeyToString,
  toCameraRelative,
} from "../app/planet/math";
import {
  proceduralCraterHeight,
  proceduralDetailHeight,
  proceduralTerrainHeightForLod,
  spatialSeed,
} from "../app/planet/noise";
import type { CubeFace } from "../app/planet/types";

describe("planetary coordinate maths", () => {
  it.each([
    [0, 0, 0],
    [18.65, -133.8, 21_000],
    [-42.4, 70.5, -7_100],
    [89.999, 179.999, 15],
    [-89.999, -179.999, 0],
  ])("round-trips latitude %s longitude %s elevation %s", (latitude, longitude, elevation) => {
    const cartesian = latLonElevationToCartesian(latitude, longitude, elevation);
    const recovered = cartesianToLatLonElevation(cartesian);
    expect(recovered.latitudeDeg).toBeCloseTo(latitude, 8);
    expect(recovered.longitudeDeg).toBeCloseTo(longitude, 8);
    expect(recovered.elevationM).toBeCloseTo(elevation, 6);
  });

  it("constructs an orthonormal east-north-up frame at poles and equator", () => {
    for (const [latitude, longitude] of [[0, 0], [0, 90], [90, 0], [-90, 120]]) {
      const basis = localEnuBasis(latitude, longitude);
      expect(dot3(basis.east, basis.north)).toBeCloseTo(0, 12);
      expect(dot3(basis.east, basis.up)).toBeCloseTo(0, 12);
      expect(dot3(basis.north, basis.up)).toBeCloseTo(0, 12);
      expect(dot3(basis.east, basis.east)).toBeCloseTo(1, 12);
      expect(dot3(basis.north, basis.north)).toBeCloseTo(1, 12);
      expect(dot3(basis.up, basis.up)).toBeCloseTo(1, 12);
    }
  });

  it("calculates altitude above queried local ground", () => {
    const camera = latLonElevationToCartesian(12, 34, 157.25);
    expect(cameraAltitudeAboveGround(camera, () => 42.25)).toBeCloseTo(115, 6);
  });

  it("refines screen rays against actual local terrain radius", () => {
    const origin = { x: MARS_REFERENCE_RADIUS_M + 50_000, y: 0, z: 0 };
    const hit = rayTerrainIntersection(origin, { x: -1, y: 0, z: 0 }, () => 12_345);
    expect(hit).not.toBeNull();
    expect(Math.abs(hit!.distance - (50_000 - 12_345))).toBeLessThan(0.02);
    expect(Math.abs(hit!.point.x - (MARS_REFERENCE_RADIUS_M + 12_345))).toBeLessThan(0.02);
  });

  it("picks elevated terrain at the limb when the reference sphere is missed", () => {
    const originRadius = MARS_REFERENCE_RADIUS_M + 100_000;
    const impactRadius = MARS_REFERENCE_RADIUS_M + 10_000;
    const sine = impactRadius / originRadius;
    const direction = { x: -Math.sqrt(1 - sine * sine), y: sine, z: 0 };
    const origin = { x: originRadius, y: 0, z: 0 };
    expect(raySphereIntersection(origin, direction, MARS_REFERENCE_RADIUS_M)).toBeNull();
    const hit = rayTerrainIntersection(origin, direction, () => 20_000);
    expect(hit).not.toBeNull();
    expect(length3(hit!.point)).toBeCloseTo(MARS_REFERENCE_RADIUS_M + 20_000, 2);
  });

  it("queries mesh-independent surface normals and slopes", () => {
    const direction = latLonElevationToCartesian(23.5, -71.2, 0, 1);
    const flat = surfaceNormalAndSlope(direction, () => 420);
    expect(dot3(flat.normal, direction)).toBeCloseTo(1, 10);
    expect(flat.slopeDegrees).toBeCloseTo(0, 7);
    const eastRising = surfaceNormalAndSlope(direction, (sample) => {
      const basis = localEnuBasis(23.5, -71.2);
      return dot3(sample, basis.east) * MARS_REFERENCE_RADIUS_M * 0.2;
    });
    expect(eastRising.slopeDegrees).toBeGreaterThan(10);
    expect(eastRising.slopeDegrees).toBeLessThan(13);
  });
});

describe("cube-sphere addressing", () => {
  const faces: CubeFace[] = ["px", "nx", "py", "ny", "pz", "nz"];

  it.each(faces)("winds face %s triangles outward for GPU front-face culling", (face) => {
    const a = faceUvToDirection(face, -0.2, -0.2);
    const b = faceUvToDirection(face, 0.2, -0.2);
    const c = faceUvToDirection(face, -0.2, 0.2);
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    const normal = {
      x: ab.y * ac.z - ab.z * ac.y,
      y: ab.z * ac.x - ab.x * ac.z,
      z: ab.x * ac.y - ab.y * ac.x,
    };
    expect(dot3(normal, faceUvToDirection(face, 0, 0))).toBeGreaterThan(0);
  });

  it.each(faces)("round-trips face %s UV away from ambiguous edges", (face) => {
    for (const [u, v] of [[0, 0], [-0.72, 0.31], [0.44, -0.68], [0.91, 0.88]]) {
      const mapped = directionToFaceUv(faceUvToDirection(face, u, v));
      expect(mapped.face).toBe(face);
      expect(mapped.u).toBeCloseTo(u, 12);
      expect(mapped.v).toBeCloseTo(v, 12);
    }
  });

  it("generates stable keys and exact parent-child relationships", () => {
    const parent = { face: "pz" as const, lod: 4, x: 7, y: 12 };
    expect(tileKeyToString(parent)).toBe("pz/4/7/12");
    const children = childTiles(parent);
    expect(children.map(tileKeyToString)).toEqual(["pz/5/14/24", "pz/5/15/24", "pz/5/14/25", "pz/5/15/25"]);
    for (const child of children) expect(parentTile(child)).toEqual(parent);
  });

  it("crosses cube-face boundaries without leaving the requested LOD", () => {
    const east = neighbourTile({ face: "px", lod: 3, x: 7, y: 4 }, "east");
    const west = neighbourTile({ face: "px", lod: 3, x: 0, y: 4 }, "west");
    expect(east.lod).toBe(3);
    expect(west.lod).toBe(3);
    expect(east.face).not.toBe("px");
    expect(west.face).not.toBe("px");
    expect(east.x).toBeGreaterThanOrEqual(0);
    expect(east.x).toBeLessThan(8);
  });

  it("selects valid tiles over seams and both poles", () => {
    for (const [lat, lon] of [[0, -180], [0, 180], [90, 0], [-90, 0], [45, 179.999]]) {
      const direction = latLonElevationToCartesian(lat, lon, 0, 1);
      const tile = directionToTile(direction, 9);
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(512);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeLessThan(512);
    }
  });
});

describe("continuous detail, zoom, and floating origin", () => {
  it("uses deterministic spatial seeds and terrain detail", () => {
    const direction = faceUvToDirection("py", 0.125, -0.75);
    expect(spatialSeed(1, 2, 3, 4)).toBe(spatialSeed(1, 2, 3, 4));
    expect(proceduralDetailHeight(direction)).toBe(proceduralDetailHeight(direction));
    expect(proceduralDetailHeight(direction)).not.toBe(proceduralDetailHeight(faceUvToDirection("py", 0.126, -0.75)));
    expect(proceduralTerrainHeightForLod(direction, 18)).toBe(proceduralTerrainHeightForLod(direction, 18));
  });

  it("adds sparse crater bowls and raised rims below the MOLA resolution", () => {
    const heights: number[] = [];
    for (let latitude = -60; latitude <= 60; latitude += 6) {
      for (let longitude = -180; longitude < 180; longitude += 8) {
        const direction = latLonElevationToCartesian(latitude, longitude, 0, 1);
        heights.push(proceduralCraterHeight(direction));
      }
    }
    expect(Math.min(...heights)).toBeLessThan(-50);
    expect(Math.max(...heights)).toBeGreaterThan(5);
  });

  it("agrees exactly for a shared cube edge direction", () => {
    const fromPx = faceUvToDirection("px", 1, 0.273);
    const fromNz = faceUvToDirection("nz", -1, 0.273);
    expect(fromPx.x).toBeCloseTo(fromNz.x, 14);
    expect(fromPx.y).toBeCloseTo(fromNz.y, 14);
    expect(fromPx.z).toBeCloseTo(fromNz.z, 14);
    expect(proceduralDetailHeight(fromPx)).toBeCloseTo(proceduralDetailHeight(fromNz), 10);
  });

  it("clamps nonlinear zoom at exact planetary limits and remains precise near ground", () => {
    expect(nonlinearZoomAltitude(MAX_CAMERA_ALTITUDE_M, 1000)).toBe(MAX_CAMERA_ALTITUDE_M);
    expect(nonlinearZoomAltitude(0, -1000)).toBe(SURFACE_EYE_HEIGHT_M);
    expect(nonlinearZoomAltitude(SURFACE_EYE_HEIGHT_M, 10)).toBeLessThan(3);
    expect(nonlinearZoomAltitude(20_000_000, -100)).toBeLessThan(20_000_000);
  });

  it("keeps camera-relative values small and preserves high/low reconstruction", () => {
    const camera = { x: 3_389_500.123456, y: -24.125, z: 1_234.75 };
    const point = { x: camera.x + 0.025, y: camera.y - 1.5, z: camera.z + 2.75 };
    expect(toCameraRelative(point, camera)).toEqual({ x: expect.closeTo(0.025, 8), y: -1.5, z: 2.75 });
    const split = splitHighLow(camera);
    expect(split.high.x + split.low.x).toBe(camera.x);
    expect(split.high.y + split.low.y).toBe(camera.y);
    expect(split.high.z + split.low.z).toBe(camera.z);
    expect(MARS_REFERENCE_RADIUS_M).toBe(3_389_500);
  });

  it("snaps local solar shadows in absolute light-plane texels at planetary coordinates", () => {
    const sun = { x: 0.71, y: 0.28, z: -0.64 };
    const camera = { x: 3_390_124.75, y: -1_234_567.25, z: 2_345_678.5 };
    const first = snappedDirectionalShadowCenter(camera, sun, 8_192, 2_048);
    expect(first.texelWorldM).toBe(8);
    expect(dot3(first.sun, first.right)).toBeCloseTo(0, 12);
    expect(dot3(first.sun, first.up)).toBeCloseTo(0, 12);
    expect(dot3(first.right, first.up)).toBeCloseTo(0, 12);
    expect(length3(first.sun)).toBeCloseTo(1, 12);
    expect(length3(first.right)).toBeCloseTo(1, 12);
    expect(length3(first.up)).toBeCloseTo(1, 12);
    const snappedRight = dot3(first.centerAbsolute, first.right) / first.texelWorldM;
    const snappedUp = dot3(first.centerAbsolute, first.up) / first.texelWorldM;
    expect(snappedRight).toBeCloseTo(Math.round(snappedRight), 8);
    expect(snappedUp).toBeCloseTo(Math.round(snappedUp), 8);
    const subTexelCamera = {
      x: camera.x + first.right.x * 2 + first.up.x * 1.5,
      y: camera.y + first.right.y * 2 + first.up.y * 1.5,
      z: camera.z + first.right.z * 2 + first.up.z * 1.5,
    };
    const moved = snappedDirectionalShadowCenter(subTexelCamera, sun, 8_192, 2_048);
    const rightStep = (dot3(moved.centerAbsolute, first.right) - dot3(first.centerAbsolute, first.right)) / first.texelWorldM;
    const upStep = (dot3(moved.centerAbsolute, first.up) - dot3(first.centerAbsolute, first.up)) / first.texelWorldM;
    expect(rightStep).toBeCloseTo(Math.round(rightStep), 7);
    expect(upStep).toBeCloseTo(Math.round(upStep), 7);
    expect(Math.abs(rightStep)).toBeLessThan(1.000001);
    expect(Math.abs(upStep)).toBeLessThan(1.000001);
    expect(length3(moved.centerRelative)).toBeLessThan(first.texelWorldM);
  });
});
