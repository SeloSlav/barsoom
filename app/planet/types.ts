export type Vec3 = { x: number; y: number; z: number };

export const CUBE_FACES = ["px", "nx", "py", "ny", "pz", "nz"] as const;
export type CubeFace = (typeof CUBE_FACES)[number];
export type TileEdge = "west" | "east" | "north" | "south";

export type TileKey = {
  face: CubeFace;
  lod: number;
  x: number;
  y: number;
};

export type LatLonElevation = {
  latitudeDeg: number;
  longitudeDeg: number;
  elevationM: number;
};

export type EnuBasis = {
  east: Vec3;
  north: Vec3;
  up: Vec3;
};

export type SurfaceQuery = {
  radiusHeightM: number;
  areoidElevationM: number;
  normal: Vec3;
  slopeDegrees: number;
};

export type PlanetTelemetry = {
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeM: number;
  desiredAltitudeM: number;
  elevationM: number;
  groundWidthM: number;
  activeTiles: number;
  loadingTiles: number;
  queuedTiles: number;
  minLod: number;
  maxLod: number;
  triangles: number;
  drawCalls: number;
  textureMemoryMb: number;
  geometryMemoryMb: number;
  workerQueue: number;
  terrainNodes: number;
  horizonCulled: number;
  depthStrategy: "reversed" | "logarithmic";
  surfaceShadows: boolean;
  shadowExtentM: number;
  nearM: number;
  farM: number;
  floatingOrigin: Vec3;
  frameMs: number;
  fps: number;
  simulationUtc: string;
  controlMode: "survey" | "surface";
  surfaceReady: boolean;
  localProxyCoherent: boolean;
};

export type DebugFlags = {
  tileBoundaries: boolean;
  cubeFaces: boolean;
  lodColours: boolean;
  normals: boolean;
  molaOnly: boolean;
  horizonCulling: boolean;
};
