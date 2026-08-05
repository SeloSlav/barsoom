import { MARS_REFERENCE_RADIUS_M, PLANET_SEED, TERRAIN_CONFIG } from "./constants";
import type { Vec3 } from "./types";

function mix32(value: number) {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

export function spatialSeed(...components: number[]) {
  let hash = PLANET_SEED >>> 0;
  for (const component of components) {
    hash = mix32(hash ^ mix32(component | 0));
  }
  return hash >>> 0;
}

function hash3(x: number, y: number, z: number, seed: number) {
  return (
    mix32(
      seed ^
        Math.imul(x, 0x1f123bb5) ^
        Math.imul(y, 0x5f356495) ^
        Math.imul(z, 0x6c8e9cf5),
    ) / 0xffffffff
  );
}

function smooth(value: number) {
  return value * value * (3 - 2 * value);
}

export function valueNoise3(x: number, y: number, z: number, seed = PLANET_SEED) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const tx = smooth(x - ix);
  const ty = smooth(y - iy);
  const tz = smooth(z - iz);
  const sample = (dx: number, dy: number, dz: number) =>
    hash3(ix + dx, iy + dy, iz + dz, seed);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const x00 = lerp(sample(0, 0, 0), sample(1, 0, 0), tx);
  const x10 = lerp(sample(0, 1, 0), sample(1, 1, 0), tx);
  const x01 = lerp(sample(0, 0, 1), sample(1, 0, 1), tx);
  const x11 = lerp(sample(0, 1, 1), sample(1, 1, 1), tx);
  return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz) * 2 - 1;
}

const DETAIL_OCTAVES = [
  { frequency: 38, amplitude: 310 },
  { frequency: 91, amplitude: 142 },
  { frequency: 218, amplitude: 61 },
  { frequency: 530, amplitude: 24 },
  { frequency: 1_320, amplitude: 8.5 },
  { frequency: 3_300, amplitude: 2.8 },
  { frequency: 8_200, amplitude: 0.82 },
  { frequency: 20_500, amplitude: 0.22 },
  // Near-ground geometry bands. These resolve from roughly 70 m down to
  // metre scale, providing deterministic playable relief instead of relying
  // on a flat fragment-shader grain once the camera reaches the surface.
  { frequency: 48_000, amplitude: 12 },
  { frequency: 110_000, amplitude: 5.2 },
  { frequency: 250_000, amplitude: 2.1 },
  { frequency: 560_000, amplitude: 0.85 },
  { frequency: 1_250_000, amplitude: 0.32 },
  { frequency: 2_800_000, amplitude: 0.11 },
] as const;

// MOLA 16 PPD is the authoritative planetary-scale shape, but it cannot
// resolve impact features below a few kilometres. These deterministic bands
// fill that missing scale with sparse, nested impact craters. Latitude-row
// cells make the field stable over the whole sphere while keeping each height
// query bounded to nearby cells instead of scanning a global crater list.
const CRATER_SCALES = [
  { minimumLod: 10, spacingM: 60_000, density: 0.30, minimumRadiusM: 4_000, maximumRadiusM: 12_000, minimumDepthM: 120, maximumDepthM: 650 },
  { minimumLod: 13, spacingM: 16_000, density: 0.34, minimumRadiusM: 900, maximumRadiusM: 3_200, minimumDepthM: 25, maximumDepthM: 180 },
  { minimumLod: 16, spacingM: 4_000, density: 0.32, minimumRadiusM: 180, maximumRadiusM: 750, minimumDepthM: 4, maximumDepthM: 38 },
  { minimumLod: 18, spacingM: 1_000, density: 0.24, minimumRadiusM: 35, maximumRadiusM: 160, minimumDepthM: 0.8, maximumDepthM: 7 },
] as const;

const TAU = Math.PI * 2;

function wrapCell(value: number, count: number) {
  return ((value % count) + count) % count;
}

function random01(seed: number, lane: number) {
  return spatialSeed(seed, lane) / 0xffffffff;
}

export function proceduralDetailHeight(direction: Vec3, resolvedOctaves: number = DETAIL_OCTAVES.length) {
  let height = 0;
  const limit = Math.max(0, Math.min(DETAIL_OCTAVES.length, resolvedOctaves));
  for (let octave = 0; octave < limit; octave += 1) {
    const layer = DETAIL_OCTAVES[octave];
    const seed = spatialSeed(0x6d617273, octave);
    const noise = valueNoise3(
      direction.x * layer.frequency + 17.1,
      direction.y * layer.frequency - 8.7,
      direction.z * layer.frequency + 3.9,
      seed,
    );
    const ridge = 1 - Math.abs(noise);
    const erosion = valueNoise3(
      direction.x * layer.frequency * 0.47 - 11,
      direction.y * layer.frequency * 0.47 + 7,
      direction.z * layer.frequency * 0.47 + 19,
      seed ^ 0x9e3779b9,
    );
    height += (noise * 0.62 + (ridge * ridge - 0.34) * 0.38) * layer.amplitude *
      (0.78 + erosion * 0.22);
  }
  return height;
}

export function resolvedDetailOctavesForLod(lod: number) {
  return Math.max(0, Math.min(DETAIL_OCTAVES.length, lod - 2));
}

export function resolvedCraterScalesForLod(lod: number) {
  let count = 0;
  for (const scale of CRATER_SCALES) {
    if (lod >= scale.minimumLod) count += 1;
  }
  return count;
}

export function proceduralCraterHeight(directionInput: Vec3, resolvedScales: number = CRATER_SCALES.length) {
  const length = Math.hypot(directionInput.x, directionInput.y, directionInput.z) || 1;
  const direction = {
    x: directionInput.x / length,
    y: directionInput.y / length,
    z: directionInput.z / length,
  };
  const latitude = Math.asin(Math.max(-1, Math.min(1, direction.y)));
  const longitude = Math.atan2(direction.z, direction.x);
  const normalizedLongitude = ((longitude + Math.PI) % TAU + TAU) % TAU;
  let height = 0;
  const limit = Math.max(0, Math.min(CRATER_SCALES.length, resolvedScales));

  for (let scaleIndex = 0; scaleIndex < limit; scaleIndex += 1) {
    const scale = CRATER_SCALES[scaleIndex];
    const latitudeStep = scale.spacingM / MARS_REFERENCE_RADIUS_M;
    const latitudeCellCount = Math.ceil(Math.PI / latitudeStep);
    const centerRow = Math.floor((latitude + Math.PI * 0.5) / latitudeStep);

    for (let rowOffset = -2; rowOffset <= 2; rowOffset += 1) {
      const row = centerRow + rowOffset;
      if (row < 0 || row >= latitudeCellCount) continue;
      const rowLatitude = -Math.PI * 0.5 + (row + 0.5) * latitudeStep;
      const longitudeCellCount = Math.max(
        4,
        Math.round(TAU * MARS_REFERENCE_RADIUS_M * Math.max(0.001, Math.abs(Math.cos(rowLatitude))) / scale.spacingM),
      );
      const centerColumn = Math.floor(normalizedLongitude / TAU * longitudeCellCount);

      for (let columnOffset = -2; columnOffset <= 2; columnOffset += 1) {
        const column = wrapCell(centerColumn + columnOffset, longitudeCellCount);
        const seed = spatialSeed(0x63726174, scaleIndex, row, column);
        if (random01(seed, 0) > scale.density) continue;

        const craterLatitude = rowLatitude + (random01(seed, 1) - 0.5) * latitudeStep * 0.66;
        const longitudeStep = TAU / longitudeCellCount;
        const craterLongitude = -Math.PI + (column + 0.5) * longitudeStep +
          (random01(seed, 2) - 0.5) * longitudeStep * 0.66;
        const cosLatitude = Math.cos(craterLatitude);
        const craterDirection = {
          x: cosLatitude * Math.cos(craterLongitude),
          y: Math.sin(craterLatitude),
          z: cosLatitude * Math.sin(craterLongitude),
        };
        const radiusT = random01(seed, 3) ** 1.45;
        const radiusM = scale.minimumRadiusM *
          (scale.maximumRadiusM / scale.minimumRadiusM) ** radiusT;
        const dot = Math.max(-1, Math.min(1,
          direction.x * craterDirection.x + direction.y * craterDirection.y + direction.z * craterDirection.z,
        ));
        const maximumDistanceM = radiusM * 1.6;
        if (dot < Math.cos(maximumDistanceM / MARS_REFERENCE_RADIUS_M)) continue;
        const distanceM = Math.acos(dot) * MARS_REFERENCE_RADIUS_M;
        if (distanceM >= maximumDistanceM) continue;

        const depthT = 0.35 + radiusT * 0.65;
        const depthM = scale.minimumDepthM *
          (scale.maximumDepthM / scale.minimumDepthM) ** depthT;
        const radiusRatio = distanceM / radiusM;
        const bowl = radiusRatio < 1
          ? -depthM * (1 - radiusRatio * radiusRatio) ** 2
          : 0;
        const rimDistance = (radiusRatio - 1) / 0.105;
        const rim = depthM * 0.22 * Math.exp(-(rimDistance * rimDistance));
        const ejecta = radiusRatio > 1
          ? depthM * 0.025 * Math.exp(-(radiusRatio - 1) * 5.5)
          : 0;
        height += bowl + rim + ejecta;
      }
    }
  }
  return height;
}

/** The exact procedural contribution baked into a mesh at a given LOD. */
export function proceduralTerrainHeightForLod(direction: Vec3, lod: number = TERRAIN_CONFIG.maxRenderLod) {
  return proceduralDetailHeight(direction, resolvedDetailOctavesForLod(lod)) +
    proceduralCraterHeight(direction, resolvedCraterScalesForLod(lod));
}
