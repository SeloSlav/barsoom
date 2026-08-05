import * as THREE from "three";
import { MARS_REFERENCE_RADIUS_M, RENDER_CONFIG, TERRAIN_CONFIG } from "../constants";
import {
  childTiles,
  clamp,
  directionToFaceUv,
  directionToTile,
  dot3,
  faceUvToDirection,
  length3,
  neighbourTile,
  normalize3,
  surfaceDifferentialDirections,
  surfaceNormalAndSlope,
  tileBounds,
  tileKeyToString,
} from "../math";
import { MolaTileLoader } from "../mola";
import { proceduralTerrainHeightForLod } from "../noise";
import type { DebugFlags, TileEdge, TileKey, Vec3 } from "../types";
import { createTerrainMaterial, createTerrainShadowMaterial, type TerrainMaterial } from "../render/materials";
import { TerrainWorkerPool, type GeneratedTileGeometry } from "./TerrainWorkerPool";

type TileState = "idle" | "loading-data" | "queued" | "ready" | "failed";

type TileRenderState = {
  fade: number;
  morph: number;
  fadeIn: boolean;
  edgeMorph?: readonly [west: number, east: number, north: number, south: number];
};

export type RenderedTerrainSurface = {
  radiusM: number;
  heightM: number;
  normal: Vec3;
  lod: number;
};

type GridSurfaceSample = Omit<RenderedTerrainSurface, "lod">;

/**
 * Intersects a radial ray with the same morphed triangle rendered by the
 * terrain vertex shader. Sampling the analytic height function is not enough:
 * a streaming tile can be both coarser and partially morphed toward its
 * parent, so that function can sit metres above or below the visible mesh.
 */
export function sampleMorphedTerrainGrid(
  directionInput: Vec3,
  key: TileKey,
  center: Vec3,
  positions: ArrayLike<number>,
  morphDeltas: ArrayLike<number>,
  morphInput: number,
  edgeMorph: readonly [west: number, east: number, north: number, south: number] = [0, 0, 0, 0],
  segments: number = TERRAIN_CONFIG.meshSegments,
): GridSurfaceSample | null {
  const direction = normalize3(directionInput);
  const mapped = directionToFaceUv(direction);
  if (mapped.face !== key.face || segments < 1) return null;

  const bounds = tileBounds(key);
  const gridX = clamp((mapped.u - bounds.u0) / (bounds.u1 - bounds.u0) * segments, 0, segments);
  const gridY = clamp((mapped.v - bounds.v0) / (bounds.v1 - bounds.v0) * segments, 0, segments);
  const column = Math.min(segments - 1, Math.floor(gridX));
  const row = Math.min(segments - 1, Math.floor(gridY));
  const tx = gridX - column;
  const ty = gridY - row;
  const gridSize = segments + 1;
  const a = row * gridSize + column;
  const b = a + 1;
  const c = a + gridSize;
  const d = c + 1;
  const triangle = tx + ty <= 1
    ? [[a, column, row], [b, column + 1, row], [c, column, row + 1]] as const
    : [[b, column + 1, row], [d, column + 1, row + 1], [c, column, row + 1]] as const;
  const morph = clamp(morphInput, 0, 1);

  const vertex = ([index, vertexColumn, vertexRow]: typeof triangle[number]) => {
    let stitchedEdgeMorph = 0;
    if (vertexColumn === 0) stitchedEdgeMorph = Math.max(stitchedEdgeMorph, edgeMorph[0]);
    if (vertexColumn === segments) stitchedEdgeMorph = Math.max(stitchedEdgeMorph, edgeMorph[1]);
    if (vertexRow === 0) stitchedEdgeMorph = Math.max(stitchedEdgeMorph, edgeMorph[2]);
    if (vertexRow === segments) stitchedEdgeMorph = Math.max(stitchedEdgeMorph, edgeMorph[3]);
    const morphWeight = Math.max(1 - morph, stitchedEdgeMorph);
    const offset = index * 3;
    return {
      x: center.x + positions[offset] - morphDeltas[offset] * morphWeight,
      y: center.y + positions[offset + 1] - morphDeltas[offset + 1] * morphWeight,
      z: center.z + positions[offset + 2] - morphDeltas[offset + 2] * morphWeight,
    };
  };

  const p0 = vertex(triangle[0]);
  const p1 = vertex(triangle[1]);
  const p2 = vertex(triangle[2]);
  const edge1X = p1.x - p0.x;
  const edge1Y = p1.y - p0.y;
  const edge1Z = p1.z - p0.z;
  const edge2X = p2.x - p0.x;
  const edge2Y = p2.y - p0.y;
  const edge2Z = p2.z - p0.z;
  let normalX = edge1Y * edge2Z - edge1Z * edge2Y;
  let normalY = edge1Z * edge2X - edge1X * edge2Z;
  let normalZ = edge1X * edge2Y - edge1Y * edge2X;
  const denominator = normalX * direction.x + normalY * direction.y + normalZ * direction.z;
  if (Math.abs(denominator) < 1e-12) return null;
  const radiusM = (normalX * p0.x + normalY * p0.y + normalZ * p0.z) / denominator;
  if (!Number.isFinite(radiusM) || radiusM <= 0) return null;

  const normalLength = Math.hypot(normalX, normalY, normalZ);
  if (normalLength < 1e-12) return null;
  if (denominator < 0) {
    normalX = -normalX;
    normalY = -normalY;
    normalZ = -normalZ;
  }
  return {
    radiusM,
    heightM: radiusM - MARS_REFERENCE_RADIUS_M,
    normal: {
      x: normalX / normalLength,
      y: normalY / normalLength,
      z: normalZ / normalLength,
    },
  };
}

export function lodTransitionVisible(dither: number, fade: number, fadeIn: boolean) {
  if (fade >= 0.999) return true;
  return fadeIn ? dither <= fade : dither > 1 - fade;
}

const TERRAIN_LOD_MERGE_ERROR_RATIO = 0.75;

/**
 * Uses separate split and merge thresholds so small camera movements cannot
 * alternate a ready parent and its children on consecutive frames.
 */
export function terrainNodeNeedsRefinement(screenError: number, wasRefined: boolean) {
  const threshold = TERRAIN_CONFIG.screenSpaceErrorPx *
    (wasRefined ? TERRAIN_LOD_MERGE_ERROR_RATIO : 1);
  return screenError > threshold;
}

export function neighbourBalanceAncestors(tile: TileKey, edge: TileEdge) {
  const neighbour = neighbourTile(tile, edge);
  const ancestors: TileKey[] = [];
  for (let lod = 0; lod < neighbour.lod; lod += 1) {
    const divisor = 2 ** (neighbour.lod - lod);
    ancestors.push({
      face: neighbour.face,
      lod,
      x: Math.floor(neighbour.x / divisor),
      y: Math.floor(neighbour.y / divisor),
    });
  }
  return { neighbour, ancestors };
}

const TILE_EDGES = ["west", "east", "north", "south"] as const;

export function coarserNeighbourEdgeMorphs(
  tile: TileKey,
  visibleTileIds: ReadonlySet<string>,
): [west: number, east: number, north: number, south: number] {
  return TILE_EDGES.map((edge) => {
    const { neighbour, ancestors } = neighbourBalanceAncestors(tile, edge);
    if (visibleTileIds.has(tileKeyToString(neighbour))) return 0;
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      if (visibleTileIds.has(tileKeyToString(ancestors[index]))) return 1;
    }
    return 0;
  }) as [number, number, number, number];
}

class PlanetTileNode {
  readonly id: string;
  state: TileState = "idle";
  parent: PlanetTileNode | null;
  children: PlanetTileNode[] | null = null;
  mesh: THREE.Mesh<THREE.BufferGeometry, TerrainMaterial> | null = null;
  center: Vec3 | null = null;
  jobId: number | null = null;
  requestToken = 0;
  lastWantedFrame = -1;
  lastUsedFrame = -1;
  childrenReadyAt = -1;
  triangleCount = 0;
  geometryBytes = 0;
  failureCount = 0;
  refined = false;

  constructor(readonly key: TileKey, parent: PlanetTileNode | null) {
    this.id = tileKeyToString(key);
    this.parent = parent;
  }
}

export type TerrainFrameStats = {
  activeTiles: number;
  loadingTiles: number;
  queuedTiles: number;
  minLod: number;
  maxLod: number;
  triangles: number;
  workerQueue: number;
  tileDataBytes: number;
  geometryBytes: number;
  nodeCount: number;
  horizonCulled: number;
};

const FACE_INDEX = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 } as const;
const MATERIAL_PERIOD_M = 4096;
const positiveModulo = (value: number, period: number) => ((value % period) + period) % period;

export class PlanetTerrain {
  private readonly roots: PlanetTileNode[];
  private readonly allNodes = new Map<string, PlanetTileNode>();
  private readonly readyNodes = new Set<PlanetTileNode>();
  private readonly visibleNodes = new Set<PlanetTileNode>();
  private readonly geometryPool: THREE.BufferGeometry[] = [];
  private readonly meshPool: Array<THREE.Mesh<THREE.BufferGeometry, TerrainMaterial>> = [];
  private readonly loader = new MolaTileLoader();
  private readonly workers = new TerrainWorkerPool();
  private readonly material = createTerrainMaterial();
  private readonly shadowMaterial = createTerrainShadowMaterial();
  private readonly projectionScreen = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly sphere = new THREE.Sphere();
  private readonly temporaryCenter = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private frame = 0;
  private nowS = 0;
  private cameraAbsolute: Vec3 = { x: 0, y: 0, z: MARS_REFERENCE_RADIUS_M + 1 };
  private focusDirection: Vec3 = { x: 0, y: 0, z: 1 };
  private viewportHeight = 1080;
  private fovRadians = Math.PI / 4;
  private debugDisableHorizonCulling = false;
  private surfaceShadowsEnabled = false;
  private geometryBytes = 0;
  private stats: TerrainFrameStats = {
    activeTiles: 0,
    loadingTiles: 0,
    queuedTiles: 0,
    minLod: 0,
    maxLod: 0,
    triangles: 0,
    workerQueue: 0,
    tileDataBytes: 0,
    geometryBytes: 0,
    nodeCount: 6,
    horizonCulled: 0,
  };

  constructor(private readonly scene: THREE.Scene) {
    this.roots = (["px", "nx", "py", "ny", "pz", "nz"] as const).map((face) => {
      const node = new PlanetTileNode({ face, lod: 0, x: 0, y: 0 }, null);
      this.allNodes.set(node.id, node);
      return node;
    });
  }

  update(
    cameraAbsolute: Vec3,
    focusDirection: Vec3,
    camera: THREE.PerspectiveCamera,
    viewportHeight: number,
    nowS: number,
    cameraAltitudeM: number,
    sunDirection: Vec3,
    debug: DebugFlags,
  ): TerrainFrameStats {
    this.frame += 1;
    this.nowS = nowS;
    this.cameraAbsolute = cameraAbsolute;
    this.focusDirection = normalize3(focusDirection);
    this.viewportHeight = viewportHeight;
    this.fovRadians = THREE.MathUtils.degToRad(camera.fov);
    this.debugDisableHorizonCulling = debug.horizonCulling;
    this.surfaceShadowsEnabled = cameraAltitudeM <= RENDER_CONFIG.surfaceShadowMaxAltitudeM &&
      dot3(normalize3(cameraAbsolute), sunDirection) > 0.01;
    this.projectionScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionScreen);
    camera.getWorldDirection(this.cameraForward);

    for (const node of this.visibleNodes) {
      if (node.mesh) node.mesh.visible = false;
    }
    this.visibleNodes.clear();
    this.stats.activeTiles = 0;
    this.stats.triangles = 0;
    this.stats.minLod = 99;
    this.stats.maxLod = 0;
    this.stats.horizonCulled = 0;

    this.material.uniforms.uSunDirection.value.set(sunDirection.x, sunDirection.y, sunDirection.z);
    this.material.uniforms.uCameraAltitude.value = cameraAltitudeM;
    this.material.uniforms.uTime.value = nowS;
    this.material.uniforms.uDebugTileBoundaries.value = debug.tileBoundaries ? 1 : 0;
    this.material.uniforms.uDebugCubeFaces.value = debug.cubeFaces ? 1 : 0;
    this.material.uniforms.uDebugLod.value = debug.lodColours ? 1 : 0;
    this.material.uniforms.uDebugNormals.value = debug.normals ? 1 : 0;
    this.material.uniforms.uDebugMolaOnly.value = debug.molaOnly ? 1 : 0;

    const rootsByPriority = [...this.roots].sort(
      (a, b) => this.visibility(b).priority - this.visibility(a).priority,
    );
    for (const root of rootsByPriority) this.visit(root, 10_000);
    this.updateVisibleEdgeMorphs();
    this.cancelStaleRequests();
    if (this.readyNodes.size > TERRAIN_CONFIG.geometryCacheSize + 12) this.evictGeometry();
    if (this.frame % 120 === 0) this.pruneStaleNodes();

    let loading = 0;
    let queued = 0;
    for (const node of this.allNodes.values()) {
      if (node.state === "loading-data") loading += 1;
      else if (node.state === "queued") queued += 1;
    }
    this.stats.loadingTiles = loading + this.loader.loadingCount;
    this.stats.queuedTiles = queued;
    this.stats.workerQueue = this.workers.queuedCount + this.workers.activeCount;
    this.stats.tileDataBytes = this.loader.cacheBytes;
    this.stats.geometryBytes = this.geometryBytes;
    this.stats.nodeCount = this.allNodes.size;
    if (this.stats.minLod === 99) this.stats.minLod = 0;
    return { ...this.stats };
  }

  private visit(node: PlanetTileNode, parentPriority: number) {
    node.lastWantedFrame = this.frame;
    const visibility = this.visibility(node);
    if (!visibility.visible) {
      if (visibility.horizon) this.stats.horizonCulled += 1;
      return;
    }

    this.ensureRequested(node, Math.max(parentPriority, visibility.priority));
    const focusTile = directionToTile(this.focusDirection, node.key.lod);
    const isFocusBranch = tileKeyToString(focusTile) === node.id;
    const isClipmapRing = visibility.focusProximity <= 2.25;
    const needsRefinement = terrainNodeNeedsRefinement(visibility.screenError, node.refined);
    const canSplit =
      needsRefinement &&
      node.key.lod < TERRAIN_CONFIG.maxRenderLod &&
      (isFocusBranch || isClipmapRing ||
        this.stats.activeTiles + 4 < TERRAIN_CONFIG.maxActiveTiles);
    if (!canSplit) {
      node.refined = false;
      node.childrenReadyAt = -1;
      this.addVisible(node, { fade: 1, morph: 1, fadeIn: false });
      return;
    }
    node.refined = true;

    // Refine the visible branch first. `isClipmapRing` guarantees concentric
    // detail rings around the viewed point; it is independent of traversal
    // order and cannot expire while sibling tiles are still transitioning.
    const children = this.ensureChildren(node);
    const childrenByPriority = [...children].sort(
      (a, b) => this.visibility(b).priority - this.visibility(a).priority,
    );
    for (const child of childrenByPriority) {
      child.lastWantedFrame = this.frame;
      const childVisibility = this.visibility(child);
      this.ensureRequested(
        child,
        (childVisibility.visible ? childVisibility.priority : visibility.priority * 0.08) + child.key.lod * 0.1,
      );
    }
    const allChildrenReady = children.every((child) => child.state === "ready");
    if (!allChildrenReady) {
      node.childrenReadyAt = -1;
      this.addVisible(node, { fade: 1, morph: 1, fadeIn: false });
      return;
    }

    if (node.childrenReadyAt < 0) node.childrenReadyAt = this.nowS;
    const transition = Math.min(1, Math.max(0, (this.nowS - node.childrenReadyAt) / TERRAIN_CONFIG.morphDurationS));
    if (transition < 1) this.addVisible(node, { fade: 1 - transition, morph: 1, fadeIn: false });
    for (const child of childrenByPriority) {
      if (transition < 1) {
        const childVisibility = this.visibility(child);
        if (childVisibility.visible) this.addVisible(child, { fade: transition, morph: transition, fadeIn: true });
      } else {
        this.visit(child, visibility.screenError);
      }
    }
  }

  private ensureChildren(node: PlanetTileNode) {
    if (node.children) return node.children;
    node.children = childTiles(node.key).map((key) => {
      const child = new PlanetTileNode(key, node);
      this.allNodes.set(child.id, child);
      return child;
    });
    return node.children;
  }

  private visibility(node: PlanetTileNode) {
    const bounds = tileBounds(node.key);
    const centerDirection = node.center
      ? normalize3(node.center)
      : faceUvToDirection(node.key.face, (bounds.u0 + bounds.u1) * 0.5, (bounds.v0 + bounds.v1) * 0.5);
    const angularRadius = Math.min(Math.PI * 0.45, 1.42 / 2 ** node.key.lod);
    const cameraRadius = length3(this.cameraAbsolute);
    const cameraDirection = normalize3(this.cameraAbsolute);
    const horizonAngle = cameraRadius > MARS_REFERENCE_RADIUS_M
      ? Math.acos(Math.min(1, MARS_REFERENCE_RADIUS_M / cameraRadius))
      : 0;
    const separation = Math.acos(Math.max(-1, Math.min(1, dot3(centerDirection, cameraDirection))));
    if (!this.debugDisableHorizonCulling && separation > horizonAngle + angularRadius * 1.28 + 0.025) {
      return { visible: false, horizon: true, screenError: 0, priority: 0, focusProximity: Infinity };
    }

    const center = node.center ?? {
      x: centerDirection.x * MARS_REFERENCE_RADIUS_M,
      y: centerDirection.y * MARS_REFERENCE_RADIUS_M,
      z: centerDirection.z * MARS_REFERENCE_RADIUS_M,
    };
    const relative = {
      x: center.x - this.cameraAbsolute.x,
      y: center.y - this.cameraAbsolute.y,
      z: center.z - this.cameraAbsolute.z,
    };
    const geometryBounds = node.mesh?.geometry.boundingSphere;
    const boundRadius = geometryBounds?.radius ?? MARS_REFERENCE_RADIUS_M * angularRadius * 1.1 + 24_000;
    this.temporaryCenter.set(relative.x, relative.y, relative.z);
    if (geometryBounds) this.temporaryCenter.add(geometryBounds.center);
    this.sphere.center.copy(this.temporaryCenter);
    this.sphere.radius = boundRadius;
    if (!this.frustum.intersectsSphere(this.sphere)) {
      return { visible: false, horizon: false, screenError: 0, priority: 0, focusProximity: Infinity };
    }
    const distance = Math.max(1, Math.hypot(relative.x, relative.y, relative.z) - boundRadius * 0.65);
    const geometricError = (MARS_REFERENCE_RADIUS_M * 2) /
      (2 ** node.key.lod * TERRAIN_CONFIG.meshSegments) * (node.key.lod < 3 ? 1.35 : 0.72);
    const screenError = (geometricError / distance) * (this.viewportHeight / (2 * Math.tan(this.fovRadians * 0.5)));
    const viewDirectionLength = Math.max(1, this.temporaryCenter.length());
    const viewAlignment = clamp(
      this.temporaryCenter.dot(this.cameraForward) / viewDirectionLength,
      -1,
      1,
    );
    const centreWeight = 0.2 + 2.8 * Math.max(0, viewAlignment) ** 6;
    const focusTile = directionToTile(this.focusDirection, node.key.lod);
    const focusPriority = tileKeyToString(focusTile) === node.id ? 1_000_000 + node.key.lod * 10_000 : 0;
    const focusSeparation = Math.acos(clamp(dot3(centerDirection, this.focusDirection), -1, 1));
    const focusProximity = focusSeparation / Math.max(angularRadius, 1e-9);
    return {
      visible: true,
      horizon: false,
      screenError,
      priority: focusPriority + screenError * centreWeight,
      focusProximity,
    };
  }

  private ensureRequested(node: PlanetTileNode, priority: number) {
    if (node.state === "ready" || node.state === "queued" || node.state === "loading-data") return;
    if (node.state === "failed" && node.failureCount >= 3) return;
    const token = ++node.requestToken;
    node.state = "loading-data";
    void this.loader.load(node.key).then((base) => {
      if (node.requestToken !== token || node.lastWantedFrame < this.frame - 4) {
        node.state = "idle";
        return;
      }
      const request = this.workers.request(node.key, base, priority);
      node.jobId = request.id;
      node.state = "queued";
      return request.promise.then((generated) => {
        if (node.requestToken !== token) return;
        node.jobId = null;
        this.installGeometry(node, generated);
      });
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      node.jobId = null;
      node.state = "failed";
      node.failureCount += 1;
      console.warn(`[terrain] ${node.id} generation failed`, error);
    });
  }

  private installGeometry(node: PlanetTileNode, generated: GeneratedTileGeometry) {
    const geometry = this.geometryPool.pop() ?? new THREE.BufferGeometry();
    for (const name of Object.keys(geometry.attributes)) geometry.deleteAttribute(name);
    geometry.setIndex(null);
    geometry.setAttribute("position", new THREE.BufferAttribute(generated.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(generated.normals, 3));
    geometry.setAttribute("planetDirection", new THREE.BufferAttribute(generated.planetDirections, 3));
    geometry.setAttribute("elevation", new THREE.BufferAttribute(generated.elevations, 1));
    geometry.setAttribute("areoidElevation", new THREE.BufferAttribute(generated.areoidElevations, 1));
    geometry.setAttribute("morphDelta", new THREE.BufferAttribute(generated.morphDelta, 3));
    geometry.setAttribute("tileUv", new THREE.BufferAttribute(generated.tileUv, 2));
    geometry.setAttribute("surfaceMask", new THREE.BufferAttribute(generated.surface, 1));
    geometry.setIndex(new THREE.BufferAttribute(generated.indices, 1));
    geometry.computeBoundingSphere();
    const mesh = this.meshPool.pop() ?? new THREE.Mesh<THREE.BufferGeometry, TerrainMaterial>();
    mesh.geometry = geometry;
    mesh.material = this.material;
    mesh.name = `Mars tile ${node.id}`;
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.userData.tileNode = node;
    mesh.userData.renderState = { fade: 1, morph: 1, fadeIn: false } satisfies TileRenderState;
    mesh.onBeforeRender = () => {
      const renderState = mesh.userData.renderState as TileRenderState;
      this.material.uniforms.uFade.value = renderState.fade;
      this.material.uniforms.uFadeIn.value = renderState.fadeIn ? 1 : 0;
      this.material.uniforms.uMorph.value = renderState.morph;
      this.material.uniforms.uEdgeMorph.value.fromArray(renderState.edgeMorph ?? [0, 0, 0, 0]);
      this.material.uniforms.uTileLod.value = node.key.lod;
      this.material.uniforms.uFaceIndex.value = FACE_INDEX[node.key.face];
      this.material.uniforms.uTileOriginModulo.value.set(
        positiveModulo(node.center!.x, MATERIAL_PERIOD_M),
        positiveModulo(node.center!.y, MATERIAL_PERIOD_M),
        positiveModulo(node.center!.z, MATERIAL_PERIOD_M),
      );
      // Every tile shares this ShaderMaterial. Three.js otherwise uploads
      // custom uniforms only for the first object using the material, leaving
      // later tiles with another tile's fade, morph, LOD and stable origin.
      this.material.uniformsNeedUpdate = true;
    };
    mesh.customDepthMaterial = this.shadowMaterial;
    mesh.receiveShadow = true;
    mesh.onBeforeShadow = () => {
      const renderState = mesh.userData.renderState as TileRenderState;
      this.shadowMaterial.uniforms.uMorph.value = renderState.morph;
      this.shadowMaterial.uniforms.uEdgeMorph.value.fromArray(renderState.edgeMorph ?? [0, 0, 0, 0]);
      this.shadowMaterial.uniforms.uTileOriginModulo.value.set(
        positiveModulo(node.center!.x, MATERIAL_PERIOD_M),
        positiveModulo(node.center!.y, MATERIAL_PERIOD_M),
        positiveModulo(node.center!.z, MATERIAL_PERIOD_M),
      );
      this.shadowMaterial.uniforms.uFade.value = renderState.fade;
      this.shadowMaterial.uniforms.uFadeIn.value = renderState.fadeIn ? 1 : 0;
      this.shadowMaterial.uniformsNeedUpdate = true;
    };
    this.scene.add(mesh);
    node.mesh = mesh;
    node.center = generated.center;
    node.triangleCount = generated.triangleCount;
    node.geometryBytes = generated.positions.byteLength + generated.normals.byteLength +
      generated.planetDirections.byteLength + generated.elevations.byteLength +
      generated.areoidElevations.byteLength + generated.morphDelta.byteLength +
      generated.tileUv.byteLength + generated.surface.byteLength + generated.indices.byteLength;
    this.geometryBytes += node.geometryBytes;
    node.state = "ready";
    node.failureCount = 0;
    this.readyNodes.add(node);
  }

  private addVisible(node: PlanetTileNode, renderState: TileRenderState) {
    if (renderState.fade <= 0.001) return;
    if (!node.mesh || node.state !== "ready") {
      if (node.parent) this.addVisible(node.parent, { fade: 1, morph: 1, fadeIn: false });
      return;
    }
    const wasVisible = this.visibleNodes.has(node);
    node.mesh.visible = true;
    node.mesh.castShadow = this.surfaceShadowsEnabled;
    node.mesh.position.set(
      node.center!.x - this.cameraAbsolute.x,
      node.center!.y - this.cameraAbsolute.y,
      node.center!.z - this.cameraAbsolute.z,
    );
    const previousState = node.mesh.userData.renderState as TileRenderState | undefined;
    node.mesh.userData.renderState = wasVisible && previousState && previousState.fade > renderState.fade
      ? previousState
      : renderState;
    node.lastUsedFrame = this.frame;
    this.visibleNodes.add(node);
    if (wasVisible) return;
    this.stats.activeTiles += 1;
    this.stats.triangles += node.triangleCount;
    this.stats.minLod = Math.min(this.stats.minLod, node.key.lod);
    this.stats.maxLod = Math.max(this.stats.maxLod, node.key.lod);
  }

  private updateVisibleEdgeMorphs() {
    const visibleTileIds = new Set([...this.visibleNodes].map((node) => node.id));
    for (const node of this.visibleNodes) {
      if (!node.mesh) continue;
      const renderState = node.mesh.userData.renderState as TileRenderState;
      renderState.edgeMorph = coarserNeighbourEdgeMorphs(node.key, visibleTileIds);
    }
  }

  private cancelStaleRequests() {
    for (const node of this.allNodes.values()) {
      if (node.lastWantedFrame >= this.frame - 5) continue;
      if (node.state === "queued" && node.jobId !== null) this.workers.cancel(node.jobId);
      if (node.state === "queued" || node.state === "loading-data") {
        node.requestToken += 1;
        node.jobId = null;
        node.state = "idle";
      }
    }
  }

  private evictGeometry() {
    const candidates = [...this.readyNodes]
      // A newly generated child is not visible until all four siblings are
      // ready. Evicting it during that short staging window makes the parent
      // wait forever and leaves close views on continent-scale geometry.
      .filter((node) => !this.visibleNodes.has(node) && node.lastWantedFrame < this.frame - 8)
      .sort((a, b) => {
        const aRecency = Math.max(a.lastUsedFrame, a.lastWantedFrame);
        const bRecency = Math.max(b.lastUsedFrame, b.lastWantedFrame);
        return aRecency - bRecency;
      });
    while (this.readyNodes.size > TERRAIN_CONFIG.geometryCacheSize && candidates.length) {
      const node = candidates.shift()!;
      this.releaseNodeGeometry(node);
    }
  }

  private pruneStaleNodes() {
    for (const root of this.roots) this.pruneChildren(root);
  }

  private pruneChildren(node: PlanetTileNode) {
    if (!node.children) return;
    for (const child of node.children) this.pruneChildren(child);
    if (node.children.some((child) => child.lastWantedFrame >= this.frame - TERRAIN_CONFIG.nodeRetentionFrames)) return;
    for (const child of node.children) this.releaseSubtree(child);
    node.children = null;
  }

  private releaseSubtree(node: PlanetTileNode) {
    if (node.children) {
      for (const child of node.children) this.releaseSubtree(child);
      node.children = null;
    }
    node.requestToken += 1;
    if (node.jobId !== null) this.workers.cancel(node.jobId);
    node.jobId = null;
    if (node.mesh) this.releaseNodeGeometry(node);
    node.state = "idle";
    this.allNodes.delete(node.id);
  }

  private releaseNodeGeometry(node: PlanetTileNode) {
    if (!node.mesh) return;
    node.mesh.removeFromParent();
    const geometry = node.mesh.geometry;
    node.mesh.visible = false;
    node.mesh.onBeforeRender = () => {};
    node.mesh.onBeforeShadow = () => {};
    node.mesh.castShadow = false;
    if (this.geometryPool.length < 24) this.geometryPool.push(geometry);
    else geometry.dispose();
    if (this.meshPool.length < 24) this.meshPool.push(node.mesh);
    node.mesh = null;
    node.center = null;
    this.geometryBytes = Math.max(0, this.geometryBytes - node.geometryBytes);
    node.geometryBytes = 0;
    node.state = "idle";
    this.readyNodes.delete(node);
  }

  sampleHeightAtLod(directionInput: Vec3, lod: number) {
    const direction = normalize3(directionInput);
    const mola = this.loader.sampleCached(direction);
    if (!mola) void this.loader.prefetchDirection(direction);
    return (mola?.radiusHeightM ?? 0) + proceduralTerrainHeightForLod(direction, lod);
  }

  sampleHeight(directionInput: Vec3) {
    return this.sampleHeightAtLod(directionInput, TERRAIN_CONFIG.maxRenderLod);
  }

  private renderedNodeAtDirection(direction: Vec3) {
    for (let lod = TERRAIN_CONFIG.maxRenderLod; lod >= 0; lod -= 1) {
      const node = this.allNodes.get(tileKeyToString(directionToTile(direction, lod)));
      if (node?.mesh?.visible && this.visibleNodes.has(node)) return node;
    }
    return null;
  }

  sampleVisibleRenderedSurface(directionInput: Vec3): RenderedTerrainSurface | null {
    const direction = normalize3(directionInput);
    const node = this.renderedNodeAtDirection(direction);
    if (node?.mesh && node.center) {
      const positions = node.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      const morphDeltas = node.mesh.geometry.getAttribute("morphDelta") as THREE.BufferAttribute;
      const renderState = node.mesh.userData.renderState as TileRenderState;
      const rendered = sampleMorphedTerrainGrid(
        direction,
        node.key,
        node.center,
        positions.array,
        morphDeltas.array,
        renderState.morph,
        renderState.edgeMorph,
      );
      if (rendered) return { ...rendered, lod: node.key.lod };
    }

    return null;
  }

  sampleRenderedSurface(directionInput: Vec3): RenderedTerrainSurface {
    const direction = normalize3(directionInput);
    const rendered = this.sampleVisibleRenderedSurface(direction);
    if (rendered) return rendered;

    // Before the first root tile is ready there is no rendered triangle to
    // intersect. LOD 0 is the closest possible representation of that pending
    // mesh and avoids snapping the player to invisible high-frequency detail.
    const lod = 0;
    const heightM = this.sampleHeightAtLod(direction, lod);
    const differential = surfaceNormalAndSlope(
      direction,
      (sampleDirection) => this.sampleHeightAtLod(sampleDirection, lod),
    );
    return {
      radiusM: MARS_REFERENCE_RADIUS_M + heightM,
      heightM,
      normal: differential.normal,
      lod,
    };
  }

  sampleSurface(directionInput: Vec3) {
    const direction = normalize3(directionInput);
    const mola = this.loader.sampleCached(direction);
    if (!mola) void this.loader.prefetchDirection(direction);
    const radiusHeightM = (mola?.radiusHeightM ?? 0) +
      proceduralTerrainHeightForLod(direction, TERRAIN_CONFIG.maxRenderLod);
    const areoidHeightM = mola?.areoidHeightM ?? 0;
    return {
      radiusHeightM,
      areoidElevationM: radiusHeightM - areoidHeightM,
    };
  }

  async querySurface(directionInput: Vec3) {
    const direction = normalize3(directionInput);
    const samples = surfaceDifferentialDirections(direction);
    await Promise.all([
      samples.direction,
      samples.east,
      samples.west,
      samples.north,
      samples.south,
    ].map((sampleDirection) => this.loader.prefetchDirection(sampleDirection)));
    const surface = this.sampleSurface(direction);
    const differential = surfaceNormalAndSlope(direction, (sampleDirection) => this.sampleHeight(sampleDirection));
    return { ...surface, normal: differential.normal, slopeDegrees: differential.slopeDegrees };
  }

  prefetch(direction: Vec3) {
    return this.loader.prefetchDirection(normalize3(direction));
  }

  dispose() {
    for (const node of this.readyNodes) this.releaseNodeGeometry(node);
    for (const geometry of this.geometryPool) geometry.dispose();
    this.geometryPool.length = 0;
    for (const mesh of this.meshPool) mesh.removeFromParent();
    this.meshPool.length = 0;
    this.material.uniforms.uOrbitalTexture.value.dispose();
    this.material.uniforms.uSurfaceDiffuse.value.dispose();
    this.material.uniforms.uSurfaceNormal.value.dispose();
    this.material.uniforms.uSurfaceRoughness.value.dispose();
    this.material.uniforms.uIceSurfaceDiffuse.value.dispose();
    this.material.uniforms.uIceSurfaceNormal.value.dispose();
    this.material.uniforms.uIceSurfaceRoughness.value.dispose();
    this.material.dispose();
    this.shadowMaterial.dispose();
    this.workers.dispose();
  }
}
