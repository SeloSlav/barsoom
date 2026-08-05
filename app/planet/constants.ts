export const MARS_REFERENCE_RADIUS_M = 3_389_500;
export const MARS_ATMOSPHERE_TOP_M = 120_000;
export const MAX_CAMERA_ALTITUDE_M = 30_000_000;
export const MIN_CAMERA_ALTITUDE_M = 0;
export const CAMERA_SURFACE_EPSILON_M = 0.12;

export const PLANET_SEED = 0x4d415253;

export const TERRAIN_CONFIG = {
  meshSegments: 24,
  assetGridSize: 65,
  assetMaxLod: 4,
  maxRenderLod: 18,
  screenSpaceErrorPx: 3.4,
  maxActiveTiles: 220,
  geometryCacheSize: 280,
  nodeRetentionFrames: 900,
  molaCacheSize: 96,
  workerCount: 2,
  skirtMinimumM: 140,
  morphDurationS: 0.28,
} as const;

export const RENDER_CONFIG = {
  maxDevicePixelRatio: 1.75,
  fovDegrees: 42,
  orbitalNearM: 20,
  surfaceNearM: 0.08,
  atmosphereQualitySteps: 6,
  adaptiveResolution: true,
  targetFrameMs: 16.67,
} as const;

export const ATMOSPHERE_CONFIG = {
  density: 0.62,
  scaleHeightM: 10_800,
  dustScaleHeightM: 6_600,
  rayleigh: [0.22, 0.105, 0.07] as const,
  mie: [0.96, 0.34, 0.13] as const,
  dust: [0.68, 0.16, 0.055] as const,
  mieG: 0.76,
  exposure: 1.25,
  limbStrength: 0.78,
  aerialPerspective: 0.92,
} as const;

export const MATERIAL_CONFIG = {
  dust: { albedo: [0.46, 0.145, 0.068] as const, roughness: 0.96 },
  regolith: { albedo: [0.31, 0.087, 0.041] as const, roughness: 0.88 },
  basalt: { albedo: [0.105, 0.052, 0.039] as const, roughness: 0.76 },
  lightRock: { albedo: [0.57, 0.245, 0.12] as const, roughness: 0.81 },
  frost: { albedo: [0.72, 0.68, 0.64] as const, roughness: 0.55 },
} as const;
