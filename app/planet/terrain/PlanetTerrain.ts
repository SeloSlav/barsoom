import * as THREE from "three";
import { MARS_REFERENCE_RADIUS_M, TERRAIN_CONFIG } from "../constants";
import {
  childTiles,
  dot3,
  faceUvToDirection,
  length3,
  normalize3,
  tileBounds,
  tileKeyToString,
} from "../math";
import { MolaTileLoader } from "../mola";
import { proceduralDetailHeight } from "../noise";
import type { DebugFlags, TileKey, Vec3 } from "../types";
import { createTerrainMaterial, type TerrainMaterial } from "../render/materials";
import { TerrainWorkerPool, type GeneratedTileGeometry } from "./TerrainWorkerPool";

type TileState = "idle" | "loading-data" | "queued" | "ready" | "failed";

type TileRenderState = {
  fade: number;
  morph: number;
};

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
  failureCount = 0;

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
  horizonCulled: number;
};

const FACE_INDEX = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 } as const;

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
  private readonly projectionScreen = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly sphere = new THREE.Sphere();
  private readonly temporaryCenter = new THREE.Vector3();
  private frame = 0;
  private nowS = 0;
  private cameraAbsolute: Vec3 = { x: 0, y: 0, z: MARS_REFERENCE_RADIUS_M + 1 };
  private viewportHeight = 1080;
  private fovRadians = Math.PI / 4;
  private stats: TerrainFrameStats = {
    activeTiles: 0,
    loadingTiles: 0,
    queuedTiles: 0,
    minLod: 0,
    maxLod: 0,
    triangles: 0,
    workerQueue: 0,
    tileDataBytes: 0,
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
    this.viewportHeight = viewportHeight;
    this.fovRadians = THREE.MathUtils.degToRad(camera.fov);
    this.projectionScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionScreen);

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

    for (const root of this.roots) this.visit(root, 10_000);
    this.cancelStaleRequests();
    if (this.readyNodes.size > TERRAIN_CONFIG.geometryCacheSize + 12) this.evictGeometry();

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

    this.ensureRequested(node, Math.max(parentPriority, visibility.screenError));
    const canSplit =
      visibility.screenError > TERRAIN_CONFIG.screenSpaceErrorPx &&
      node.key.lod < TERRAIN_CONFIG.maxRenderLod &&
      this.stats.activeTiles + 4 < TERRAIN_CONFIG.maxActiveTiles;
    if (!canSplit) {
      this.addVisible(node, { fade: 1, morph: 1 });
      return;
    }

    if (!node.children) {
      node.children = childTiles(node.key).map((key) => {
        const child = new PlanetTileNode(key, node);
        this.allNodes.set(child.id, child);
        return child;
      });
    }
    for (const child of node.children) {
      child.lastWantedFrame = this.frame;
      this.ensureRequested(child, visibility.screenError + child.key.lod * 0.1);
    }
    const allChildrenReady = node.children.every((child) => child.state === "ready");
    if (!allChildrenReady) {
      node.childrenReadyAt = -1;
      this.addVisible(node, { fade: 1, morph: 1 });
      return;
    }

    if (node.childrenReadyAt < 0) node.childrenReadyAt = this.nowS;
    const transition = Math.min(1, Math.max(0, (this.nowS - node.childrenReadyAt) / TERRAIN_CONFIG.morphDurationS));
    if (transition < 1) this.addVisible(node, { fade: 1 - transition, morph: 1 });
    for (const child of node.children) {
      if (transition < 1) {
        const childVisibility = this.visibility(child);
        if (childVisibility.visible) this.addVisible(child, { fade: transition, morph: transition });
      } else {
        this.visit(child, visibility.screenError);
      }
    }
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
    if (separation > horizonAngle + angularRadius * 1.28 + 0.025) {
      return { visible: false, horizon: true, screenError: 0 };
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
    const boundRadius = MARS_REFERENCE_RADIUS_M * angularRadius * 1.1 + 24_000;
    this.temporaryCenter.set(relative.x, relative.y, relative.z);
    this.sphere.center.copy(this.temporaryCenter);
    this.sphere.radius = boundRadius;
    if (!this.frustum.intersectsSphere(this.sphere)) {
      return { visible: false, horizon: false, screenError: 0 };
    }
    const distance = Math.max(1, Math.hypot(relative.x, relative.y, relative.z) - boundRadius * 0.65);
    const geometricError = (MARS_REFERENCE_RADIUS_M * 2) /
      (2 ** node.key.lod * TERRAIN_CONFIG.meshSegments) * (node.key.lod < 3 ? 1.35 : 0.72);
    const screenError = (geometricError / distance) * (this.viewportHeight / (2 * Math.tan(this.fovRadians * 0.5)));
    return { visible: true, horizon: false, screenError };
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
    mesh.userData.renderState = { fade: 1, morph: 1 } satisfies TileRenderState;
    mesh.onBeforeRender = () => {
      const renderState = mesh.userData.renderState as TileRenderState;
      this.material.uniforms.uFade.value = renderState.fade;
      this.material.uniforms.uMorph.value = renderState.morph;
      this.material.uniforms.uTileLod.value = node.key.lod;
      this.material.uniforms.uFaceIndex.value = FACE_INDEX[node.key.face];
    };
    this.scene.add(mesh);
    node.mesh = mesh;
    node.center = generated.center;
    node.triangleCount = generated.triangleCount;
    node.state = "ready";
    node.failureCount = 0;
    this.readyNodes.add(node);
  }

  private addVisible(node: PlanetTileNode, renderState: TileRenderState) {
    if (!node.mesh || node.state !== "ready" || renderState.fade <= 0.001) {
      if (node.parent) this.addVisible(node.parent, { fade: 1, morph: 1 });
      return;
    }
    node.mesh.visible = true;
    node.mesh.position.set(
      node.center!.x - this.cameraAbsolute.x,
      node.center!.y - this.cameraAbsolute.y,
      node.center!.z - this.cameraAbsolute.z,
    );
    node.mesh.userData.renderState = renderState;
    node.lastUsedFrame = this.frame;
    this.visibleNodes.add(node);
    this.stats.activeTiles += 1;
    this.stats.triangles += node.triangleCount;
    this.stats.minLod = Math.min(this.stats.minLod, node.key.lod);
    this.stats.maxLod = Math.max(this.stats.maxLod, node.key.lod);
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
      .filter((node) => !this.visibleNodes.has(node))
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    while (this.readyNodes.size > TERRAIN_CONFIG.geometryCacheSize && candidates.length) {
      const node = candidates.shift()!;
      this.releaseNodeGeometry(node);
    }
  }

  private releaseNodeGeometry(node: PlanetTileNode) {
    if (!node.mesh) return;
    node.mesh.removeFromParent();
    const geometry = node.mesh.geometry;
    node.mesh.visible = false;
    node.mesh.onBeforeRender = () => {};
    if (this.geometryPool.length < 24) this.geometryPool.push(geometry);
    else geometry.dispose();
    if (this.meshPool.length < 24) this.meshPool.push(node.mesh);
    node.mesh = null;
    node.center = null;
    node.state = "idle";
    this.readyNodes.delete(node);
  }

  sampleHeight(directionInput: Vec3) {
    const direction = normalize3(directionInput);
    const mola = this.loader.sampleCached(direction);
    if (!mola) void this.loader.prefetchDirection(direction);
    return (mola?.radiusHeightM ?? 0) + proceduralDetailHeight(direction);
  }

  sampleSurface(directionInput: Vec3) {
    const direction = normalize3(directionInput);
    const mola = this.loader.sampleCached(direction);
    if (!mola) void this.loader.prefetchDirection(direction);
    const radiusHeightM = (mola?.radiusHeightM ?? 0) + proceduralDetailHeight(direction);
    const areoidHeightM = mola?.areoidHeightM ?? 0;
    return {
      radiusHeightM,
      areoidElevationM: radiusHeightM - areoidHeightM,
    };
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
    this.material.dispose();
    this.workers.dispose();
  }
}
