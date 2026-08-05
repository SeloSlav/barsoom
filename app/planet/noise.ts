import { PLANET_SEED } from "./constants";
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

export function proceduralDetailHeight(direction: Vec3, resolvedOctaves = DETAIL_OCTAVES.length) {
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
