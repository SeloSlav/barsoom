import * as THREE from "three";
import { MARS_REFERENCE_RADIUS_M } from "../constants";
import { clamp, normalize3 } from "../math";
import { spatialSeed } from "../noise";
import type { Vec3 } from "../types";

const TAU = Math.PI * 2;
const SURFACE_DETAIL_MAX_ALTITUDE_M = 8_000;
const SURFACE_DETAIL_REBUILD_DISTANCE_M = 320;

export type SurfaceScatterConfig = {
  radiusM: number;
  spacingM: number;
  density: number;
  minimumSizeM: number;
  maximumSizeM: number;
  maximumInstances: number;
  seedSalt: number;
};

export type SurfaceScatterPoint = {
  direction: Vec3;
  sizeM: number;
  yawRad: number;
  stretch: Vec3;
  tint: number;
};

const BOULDER_FIELD: SurfaceScatterConfig = {
  radiusM: 6_000,
  spacingM: 165,
  density: 0.2,
  minimumSizeM: 0.8,
  maximumSizeM: 9,
  maximumInstances: 1_100,
  seedSalt: 0x626f756c,
};

const ROCK_FIELD: SurfaceScatterConfig = {
  radiusM: 850,
  spacingM: 22,
  density: 0.42,
  minimumSizeM: 0.09,
  maximumSizeM: 1.25,
  maximumInstances: 2_200,
  seedSalt: 0x726f636b,
};

function wrapCell(value: number, count: number) {
  return ((value % count) + count) % count;
}

function random01(seed: number, lane: number) {
  return spatialSeed(seed, lane) / 0xffffffff;
}

/**
 * Produces a stable, planet-wide scatter grid. Latitude rows and wrapped
 * longitude cells make overlapping fields return the same rocks after travel,
 * instead of rebuilding a new random patch around the camera each time.
 */
export function generateSurfaceScatter(centerInput: Vec3, config: SurfaceScatterConfig) {
  const center = normalize3(centerInput);
  const centerLatitude = Math.asin(clamp(center.y, -1, 1));
  const centerLongitude = Math.atan2(center.z, center.x);
  const latitudeStep = config.spacingM / MARS_REFERENCE_RADIUS_M;
  const latitudeCellCount = Math.ceil(Math.PI / latitudeStep);
  const centerRow = Math.floor((centerLatitude + Math.PI * 0.5) / latitudeStep);
  const rowRadius = Math.ceil(config.radiusM / config.spacingM) + 2;
  const points: SurfaceScatterPoint[] = [];
  const visited = new Set<string>();

  for (let rowOffset = -rowRadius; rowOffset <= rowRadius; rowOffset += 1) {
    const row = centerRow + rowOffset;
    if (row < 0 || row >= latitudeCellCount) continue;
    const rowLatitude = -Math.PI * 0.5 + (row + 0.5) * latitudeStep;
    const northM = (rowLatitude - centerLatitude) * MARS_REFERENCE_RADIUS_M;
    if (Math.abs(northM) > config.radiusM + config.spacingM) continue;
    const eastRadiusM = Math.sqrt(Math.max(0, config.radiusM ** 2 - northM ** 2));
    const longitudeCellCount = Math.max(
      4,
      Math.round(TAU * MARS_REFERENCE_RADIUS_M * Math.max(0.001, Math.abs(Math.cos(rowLatitude))) / config.spacingM),
    );
    const normalizedLongitude = ((centerLongitude + Math.PI) % TAU + TAU) % TAU;
    const centerColumn = Math.floor(normalizedLongitude / TAU * longitudeCellCount);
    const columnRadius = Math.ceil(eastRadiusM / config.spacingM) + 2;

    for (let columnOffset = -columnRadius; columnOffset <= columnRadius; columnOffset += 1) {
      const column = wrapCell(centerColumn + columnOffset, longitudeCellCount);
      const id = `${row}:${column}`;
      if (visited.has(id)) continue;
      visited.add(id);
      const seed = spatialSeed(config.seedSalt, row, column);
      if (random01(seed, 0) > config.density) continue;

      const latitude = rowLatitude + (random01(seed, 1) - 0.5) * latitudeStep * 0.72;
      const longitudeStep = TAU / longitudeCellCount;
      const longitude = -Math.PI + (column + 0.5) * longitudeStep +
        (random01(seed, 2) - 0.5) * longitudeStep * 0.72;
      const cosLatitude = Math.cos(latitude);
      const direction = {
        x: cosLatitude * Math.cos(longitude),
        y: Math.sin(latitude),
        z: cosLatitude * Math.sin(longitude),
      };
      const angularDistance = Math.acos(clamp(
        center.x * direction.x + center.y * direction.y + center.z * direction.z,
        -1,
        1,
      ));
      if (angularDistance * MARS_REFERENCE_RADIUS_M > config.radiusM) continue;

      const sizeT = random01(seed, 3) ** 1.7;
      const sizeM = config.minimumSizeM *
        (config.maximumSizeM / config.minimumSizeM) ** sizeT;
      points.push({
        direction,
        sizeM,
        yawRad: random01(seed, 4) * TAU,
        stretch: {
          x: 0.62 + random01(seed, 5) * 0.72,
          y: 0.58 + random01(seed, 6) * 0.78,
          z: 0.62 + random01(seed, 7) * 0.72,
        },
        tint: random01(seed, 8),
      });
      if (points.length >= config.maximumInstances) return points;
    }
  }
  return points;
}

type SurfaceField = {
  mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  config: SurfaceScatterConfig;
  instances: Array<{
    absolute: THREE.Vector3;
    rotation: THREE.Quaternion;
    scale: THREE.Vector3;
  }>;
  dark: THREE.Color;
  light: THREE.Color;
  maxAltitudeM: number;
};

export class SurfaceDetailRenderer {
  private readonly fields: SurfaceField[];
  private readonly anchorDirection = new THREE.Vector3();
  private readonly cameraAbsolute = new THREE.Vector3();
  private readonly localPosition = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private readonly align = new THREE.Quaternion();
  private readonly twist = new THREE.Quaternion();
  private readonly direction = new THREE.Vector3();
  private readonly colour = new THREE.Color();
  private hasAnchor = false;

  constructor(
    scene: THREE.Scene,
    private readonly sampleHeight: (direction: Vec3) => number,
  ) {
    const boulderGeometry = new THREE.DodecahedronGeometry(1, 0);
    const rockGeometry = new THREE.IcosahedronGeometry(1, 0);
    const makeMaterial = () => new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.97,
      metalness: 0,
      flatShading: true,
      vertexColors: true,
      emissive: 0x120403,
      emissiveIntensity: 0.12,
    });
    this.fields = [
      {
        mesh: new THREE.InstancedMesh(boulderGeometry, makeMaterial(), BOULDER_FIELD.maximumInstances),
        config: BOULDER_FIELD,
        instances: [],
        dark: new THREE.Color(0x35140c),
        light: new THREE.Color(0x8d3e20),
        maxAltitudeM: SURFACE_DETAIL_MAX_ALTITUDE_M,
      },
      {
        mesh: new THREE.InstancedMesh(rockGeometry, makeMaterial(), ROCK_FIELD.maximumInstances),
        config: ROCK_FIELD,
        instances: [],
        dark: new THREE.Color(0x25100b),
        light: new THREE.Color(0x71301b),
        maxAltitudeM: 1_500,
      },
    ];

    for (const [index, field] of this.fields.entries()) {
      field.mesh.name = index === 0 ? "Mars deterministic boulder field" : "Mars deterministic rock field";
      field.mesh.count = 0;
      field.mesh.visible = false;
      field.mesh.frustumCulled = false;
      field.mesh.castShadow = index === 0;
      field.mesh.receiveShadow = true;
      field.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(field.mesh);
    }
  }

  update(cameraAbsoluteInput: Vec3, cameraDirectionInput: Vec3, altitudeM: number) {
    const visible = altitudeM <= SURFACE_DETAIL_MAX_ALTITUDE_M;
    for (const field of this.fields) field.mesh.visible = altitudeM <= field.maxAltitudeM;
    if (!visible) return;

    const cameraDirection = normalize3(cameraDirectionInput);
    const anchorDistanceM = this.hasAnchor
      ? Math.acos(clamp(
        this.anchorDirection.x * cameraDirection.x +
          this.anchorDirection.y * cameraDirection.y +
          this.anchorDirection.z * cameraDirection.z,
        -1,
        1,
      )) * MARS_REFERENCE_RADIUS_M
      : Infinity;
    if (anchorDistanceM > SURFACE_DETAIL_REBUILD_DISTANCE_M) this.rebuild(cameraDirection);

    this.cameraAbsolute.set(cameraAbsoluteInput.x, cameraAbsoluteInput.y, cameraAbsoluteInput.z);
    for (const field of this.fields) {
      if (!field.mesh.visible) continue;
      for (let index = 0; index < field.instances.length; index += 1) {
        const instance = field.instances[index];
        this.localPosition.copy(instance.absolute).sub(this.cameraAbsolute);
        this.matrix.compose(this.localPosition, instance.rotation, instance.scale);
        field.mesh.setMatrixAt(index, this.matrix);
      }
      field.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private rebuild(centerDirection: Vec3) {
    this.anchorDirection.set(centerDirection.x, centerDirection.y, centerDirection.z).normalize();
    this.hasAnchor = true;
    const modelUp = new THREE.Vector3(0, 1, 0);

    for (const field of this.fields) {
      const points = generateSurfaceScatter(centerDirection, field.config);
      field.instances = points.map((point, index) => {
        this.direction.set(point.direction.x, point.direction.y, point.direction.z).normalize();
        const heightM = this.sampleHeight(point.direction);
        const absolute = this.direction.clone().multiplyScalar(
          MARS_REFERENCE_RADIUS_M + heightM - point.sizeM * 0.12,
        );
        this.align.setFromUnitVectors(modelUp, this.direction);
        this.twist.setFromAxisAngle(this.direction, point.yawRad);
        const rotation = this.twist.clone().multiply(this.align);
        const scale = new THREE.Vector3(
          point.sizeM * point.stretch.x,
          point.sizeM * point.stretch.y,
          point.sizeM * point.stretch.z,
        );
        this.colour.copy(field.dark).lerp(field.light, 0.18 + point.tint * 0.72);
        field.mesh.setColorAt(index, this.colour);
        return { absolute, rotation, scale };
      });
      field.mesh.count = field.instances.length;
      if (field.mesh.instanceColor) field.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    for (const field of this.fields) {
      field.mesh.removeFromParent();
      field.mesh.geometry.dispose();
      field.mesh.material.dispose();
    }
  }
}
