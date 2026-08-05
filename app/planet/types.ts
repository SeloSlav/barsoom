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

export type PlanetTelemetry = {
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeM: number;
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
  nearM: number;
  farM: number;
  floatingOrigin: Vec3;
  frameMs: number;
  fps: number;
  simulationUtc: string;
};

export type DebugFlags = {
  overlay: boolean;
  tileBoundaries: boolean;
  cubeFaces: boolean;
  lodColours: boolean;
  normals: boolean;
  molaOnly: boolean;
  horizonCulling: boolean;
};
