import {
  MAX_CAMERA_ALTITUDE_M,
  MARS_REFERENCE_RADIUS_M,
  MIN_CAMERA_ALTITUDE_M,
} from "./constants";
import type {
  CubeFace,
  EnuBasis,
  LatLonElevation,
  TileEdge,
  TileKey,
  Vec3,
} from "./types";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function wrapLongitudeDegrees(longitudeDeg: number) {
  const wrapped = ((longitudeDeg + 180) % 360 + 360) % 360 - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

export function length3(value: Vec3) {
  return Math.hypot(value.x, value.y, value.z);
}

export function normalize3(value: Vec3): Vec3 {
  const length = length3(value);
  if (length === 0) return { x: 0, y: 1, z: 0 };
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subtract3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale3(value: Vec3, scale: number): Vec3 {
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

export function dot3(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function latLonElevationToCartesian(
  latitudeDeg: number,
  longitudeDeg: number,
  elevationM = 0,
  radiusM = MARS_REFERENCE_RADIUS_M,
): Vec3 {
  const latitude = clamp(latitudeDeg, -90, 90) * DEG2RAD;
  const longitude = wrapLongitudeDegrees(longitudeDeg) * DEG2RAD;
  const radius = radiusM + elevationM;
  const cosLatitude = Math.cos(latitude);
  return {
    x: radius * cosLatitude * Math.cos(longitude),
    y: radius * Math.sin(latitude),
    z: radius * cosLatitude * Math.sin(longitude),
  };
}

export function cartesianToLatLonElevation(
  cartesian: Vec3,
  radiusM = MARS_REFERENCE_RADIUS_M,
): LatLonElevation {
  const radius = length3(cartesian);
  if (radius === 0) {
    return { latitudeDeg: 0, longitudeDeg: 0, elevationM: -radiusM };
  }
  return {
    latitudeDeg: Math.asin(clamp(cartesian.y / radius, -1, 1)) * RAD2DEG,
    longitudeDeg: wrapLongitudeDegrees(Math.atan2(cartesian.z, cartesian.x) * RAD2DEG),
    elevationM: radius - radiusM,
  };
}

export function localEnuBasis(latitudeDeg: number, longitudeDeg: number): EnuBasis {
  const latitude = latitudeDeg * DEG2RAD;
  const longitude = longitudeDeg * DEG2RAD;
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);
  const east = { x: -sinLongitude, y: 0, z: cosLongitude };
  const up = {
    x: cosLatitude * cosLongitude,
    y: sinLatitude,
    z: cosLatitude * sinLongitude,
  };
  return { east, north: normalize3(cross3(up, east)), up };
}

export function directionToEnuBasis(direction: Vec3): EnuBasis {
  const coordinates = cartesianToLatLonElevation(normalize3(direction), 1);
  return localEnuBasis(coordinates.latitudeDeg, coordinates.longitudeDeg);
}

export function faceUvToDirection(face: CubeFace, u: number, v: number): Vec3 {
  switch (face) {
    case "px":
      return normalize3({ x: 1, y: v, z: -u });
    case "nx":
      return normalize3({ x: -1, y: v, z: u });
    case "py":
      return normalize3({ x: u, y: 1, z: -v });
    case "ny":
      return normalize3({ x: u, y: -1, z: v });
    case "pz":
      return normalize3({ x: u, y: v, z: 1 });
    case "nz":
      return normalize3({ x: -u, y: v, z: -1 });
  }
}

export function directionToFaceUv(directionInput: Vec3): {
  face: CubeFace;
  u: number;
  v: number;
} {
  const direction = normalize3(directionInput);
  const ax = Math.abs(direction.x);
  const ay = Math.abs(direction.y);
  const az = Math.abs(direction.z);
  if (ax >= ay && ax >= az) {
    return direction.x >= 0
      ? { face: "px", u: -direction.z / ax, v: direction.y / ax }
      : { face: "nx", u: direction.z / ax, v: direction.y / ax };
  }
  if (ay >= az) {
    return direction.y >= 0
      ? { face: "py", u: direction.x / ay, v: -direction.z / ay }
      : { face: "ny", u: direction.x / ay, v: direction.z / ay };
  }
  return direction.z >= 0
    ? { face: "pz", u: direction.x / az, v: direction.y / az }
    : { face: "nz", u: -direction.x / az, v: direction.y / az };
}

export function tileKeyToString(tile: TileKey) {
  return `${tile.face}/${tile.lod}/${tile.x}/${tile.y}`;
}

export function parseTileKey(key: string): TileKey {
  const [face, lod, x, y] = key.split("/");
  if (!face || lod === undefined || x === undefined || y === undefined) {
    throw new Error(`Invalid tile key: ${key}`);
  }
  return { face: face as CubeFace, lod: Number(lod), x: Number(x), y: Number(y) };
}

export function tileBounds(tile: TileKey) {
  const count = 2 ** tile.lod;
  const size = 2 / count;
  return {
    u0: -1 + tile.x * size,
    v0: -1 + tile.y * size,
    u1: -1 + (tile.x + 1) * size,
    v1: -1 + (tile.y + 1) * size,
  };
}

export function directionToTile(direction: Vec3, lod: number): TileKey {
  const mapped = directionToFaceUv(direction);
  const count = 2 ** lod;
  return {
    face: mapped.face,
    lod,
    x: clamp(Math.floor(((mapped.u + 1) * 0.5) * count), 0, count - 1),
    y: clamp(Math.floor(((mapped.v + 1) * 0.5) * count), 0, count - 1),
  };
}

export function parentTile(tile: TileKey): TileKey | null {
  if (tile.lod === 0) return null;
  return {
    face: tile.face,
    lod: tile.lod - 1,
    x: Math.floor(tile.x / 2),
    y: Math.floor(tile.y / 2),
  };
}

export function childTiles(tile: TileKey): [TileKey, TileKey, TileKey, TileKey] {
  const lod = tile.lod + 1;
  const x = tile.x * 2;
  const y = tile.y * 2;
  return [
    { face: tile.face, lod, x, y },
    { face: tile.face, lod, x: x + 1, y },
    { face: tile.face, lod, x, y: y + 1 },
    { face: tile.face, lod, x: x + 1, y: y + 1 },
  ];
}

export function neighbourTile(tile: TileKey, edge: TileEdge): TileKey {
  const count = 2 ** tile.lod;
  const dx = edge === "west" ? -1 : edge === "east" ? 1 : 0;
  const dy = edge === "north" ? -1 : edge === "south" ? 1 : 0;
  const x = tile.x + dx;
  const y = tile.y + dy;
  if (x >= 0 && y >= 0 && x < count && y < count) {
    return { face: tile.face, lod: tile.lod, x, y };
  }
  const size = 2 / count;
  const u = -1 + (x + 0.5) * size;
  const v = -1 + (y + 0.5) * size;
  return directionToTile(faceUvToDirection(tile.face, u, v), tile.lod);
}

export function bilinearSample(
  values: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
) {
  const x0 = clamp(Math.floor(x), 0, width - 1);
  const y0 = clamp(Math.floor(y), 0, height - 1);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = clamp(x - x0, 0, 1);
  const ty = clamp(y - y0, 0, 1);
  const a = values[y0 * width + x0] * (1 - tx) + values[y0 * width + x1] * tx;
  const b = values[y1 * width + x0] * (1 - tx) + values[y1 * width + x1] * tx;
  return a * (1 - ty) + b * ty;
}

export function cameraAltitudeAboveGround(
  cameraAbsolute: Vec3,
  terrainHeightM: (direction: Vec3) => number,
) {
  const radius = length3(cameraAbsolute);
  const direction = normalize3(cameraAbsolute);
  return radius - (MARS_REFERENCE_RADIUS_M + terrainHeightM(direction));
}

export function nonlinearZoomAltitude(
  currentAltitudeM: number,
  wheelDelta: number,
  sensitivity = 0.00135,
  altitudeBiasM = 2.5,
) {
  return clamp(
    (currentAltitudeM + altitudeBiasM) * Math.exp(wheelDelta * sensitivity) -
      altitudeBiasM,
    MIN_CAMERA_ALTITUDE_M,
    MAX_CAMERA_ALTITUDE_M,
  );
}

export function toCameraRelative(absolute: Vec3, cameraAbsolute: Vec3): Vec3 {
  return subtract3(absolute, cameraAbsolute);
}

export function splitHighLow(value: Vec3): { high: Vec3; low: Vec3 } {
  const split = (component: number) => {
    const high = Math.fround(component);
    return [high, component - high] as const;
  };
  const [hx, lx] = split(value.x);
  const [hy, ly] = split(value.y);
  const [hz, lz] = split(value.z);
  return { high: { x: hx, y: hy, z: hz }, low: { x: lx, y: ly, z: lz } };
}

export function raySphereIntersection(
  rayOrigin: Vec3,
  rayDirectionInput: Vec3,
  radiusM: number,
): number | null {
  const rayDirection = normalize3(rayDirectionInput);
  const b = dot3(rayOrigin, rayDirection);
  const c = dot3(rayOrigin, rayOrigin) - radiusM * radiusM;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const near = -b - root;
  const far = -b + root;
  if (near >= 0) return near;
  return far >= 0 ? far : null;
}

