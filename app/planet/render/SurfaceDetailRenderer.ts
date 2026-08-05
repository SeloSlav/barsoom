import * as THREE from "three";
import { MARS_REFERENCE_RADIUS_M } from "../constants";
import { clamp, normalize3 } from "../math";
import { spatialSeed } from "../noise";
import type { Vec3 } from "../types";

const TAU = Math.PI * 2;
const SURFACE_DETAIL_MAX_ALTITUDE_M = 8_000;
const SURFACE_DETAIL_REBUILD_DISTANCE_M = 320;
const BOULDER_GROUNDING_REFRESH_BUDGET = 128;
const ROCK_GROUNDING_REFRESH_BUDGET = 384;

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

export type SurfaceRockPlacement = {
  absolute: Vec3;
  normal: Vec3;
  scale: Vec3;
};

export type SurfaceRockSupport = {
  radiusM: number;
  normal: Vec3;
};

function createSurfaceRockTexture(
  path: string,
  name: string,
  fallback: [number, number, number, number],
  colour = false,
) {
  let texture: THREE.Texture;
  if (typeof document === "undefined") {
    texture = new THREE.DataTexture(new Uint8Array(fallback), 1, 1, THREE.RGBAFormat);
    texture.needsUpdate = true;
  } else {
    texture = new THREE.TextureLoader().load(path);
  }
  texture.name = name;
  texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  return texture;
}

export function createSurfaceRockMaterial() {
  const diffuse = createSurfaceRockTexture(
    "/textures/mars-rock-diffuse.jpg?revision=polyhaven-rocks-ground-02-1k",
    "Surface rock diffuse texture",
    [128, 78, 48, 255],
    true,
  );
  const normal = createSurfaceRockTexture(
    "/textures/mars-rock-normal-gl.jpg?revision=polyhaven-rocks-ground-02-1k",
    "Surface rock OpenGL normal texture",
    [128, 128, 255, 255],
  );
  const roughness = createSurfaceRockTexture(
    "/textures/mars-rock-roughness.jpg?revision=polyhaven-rocks-ground-02-1k",
    "Surface rock roughness texture",
    [235, 235, 235, 255],
  );
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: diffuse,
    normalMap: normal,
    // The terrain normal map describes shallow ground relief. On a faceted
    // boulder its former strength overwhelmed the mesh normals and turned
    // broad faces away from every light source.
    normalScale: new THREE.Vector2(0.2, 0.2),
    roughnessMap: roughness,
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
    vertexColors: true,
    // This is the same texture-backed dusty-sky bounce used conceptually by
    // the terrain shader. White is intentional: emissiveMap already supplies
    // the rock colour. The former near-black multiplier erased that map.
    emissive: 0xffffff,
    emissiveMap: diffuse,
    emissiveIntensity: 0.24,
  });
}

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

/**
 * Grounds a rock against the exact visible terrain triangle and aligns its
 * local up axis to that triangle's normal.
 */
export function calculateSurfaceRockPlacement(
  point: SurfaceScatterPoint,
  support: SurfaceRockSupport,
): SurfaceRockPlacement {
  const direction = normalize3(point.direction);
  const normal = normalize3(support.normal);
  if (normal.x * direction.x + normal.y * direction.y + normal.z * direction.z < 0) {
    normal.x *= -1;
    normal.y *= -1;
    normal.z *= -1;
  }
  const scale = {
    x: point.sizeM * point.stretch.x,
    y: point.sizeM * point.stretch.y,
    z: point.sizeM * point.stretch.z,
  };
  const surface = {
    x: direction.x * support.radiusM,
    y: direction.y * support.radiusM,
    z: direction.z * support.radiusM,
  };
  // Keep most of the irregular primitive below its supporting triangle. This
  // prevents a low-poly corner from reading as a hovering contact point.
  const exposedCenterM = scale.y * 0.32;
  return {
    absolute: {
      x: surface.x + normal.x * exposedCenterM,
      y: surface.y + normal.y * exposedCenterM,
      z: surface.z + normal.z * exposedCenterM,
    },
    normal,
    scale,
  };
}

type SurfaceField = {
  mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  config: SurfaceScatterConfig;
  instances: Array<{
    point: SurfaceScatterPoint;
    absolute: THREE.Vector3;
    rotation: THREE.Quaternion;
    scale: THREE.Vector3;
    grounded: boolean;
  }>;
  dark: THREE.Color;
  light: THREE.Color;
  maxAltitudeM: number;
  groundingCursor: number;
  groundingRefreshBudget: number;
};

export class SurfaceDetailRenderer {
  private readonly fields: SurfaceField[];
  private readonly rockSkyFill = new THREE.HemisphereLight(0xffc2a1, 0x39120a, 0.58);
  private readonly anchorDirection = new THREE.Vector3();
  private readonly cameraAbsolute = new THREE.Vector3();
  private readonly localPosition = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private readonly align = new THREE.Quaternion();
  private readonly twist = new THREE.Quaternion();
  private readonly direction = new THREE.Vector3();
  private readonly colour = new THREE.Color();
  private readonly hiddenScale = new THREE.Vector3(0, 0, 0);
  private readonly modelUp = new THREE.Vector3(0, 1, 0);
  private hasAnchor = false;

  constructor(
    scene: THREE.Scene,
    private readonly sampleVisibleSurface: (direction: Vec3) => SurfaceRockSupport | null,
  ) {
    const boulderGeometry = new THREE.DodecahedronGeometry(1, 0);
    const rockGeometry = new THREE.IcosahedronGeometry(1, 0);
    this.rockSkyFill.name = "Mars dusty-sky rock fill";
    this.rockSkyFill.visible = false;
    scene.add(this.rockSkyFill);
    this.fields = [
      {
        mesh: new THREE.InstancedMesh(boulderGeometry, createSurfaceRockMaterial(), BOULDER_FIELD.maximumInstances),
        config: BOULDER_FIELD,
        instances: [],
        // Instance colours multiply the diffuse map. Keep them light enough
        // to colour-grade the rock without crushing its photographed detail.
        dark: new THREE.Color(0xc07a59),
        light: new THREE.Color(0xf0b48b),
        maxAltitudeM: SURFACE_DETAIL_MAX_ALTITUDE_M,
        groundingCursor: 0,
        groundingRefreshBudget: BOULDER_GROUNDING_REFRESH_BUDGET,
      },
      {
        mesh: new THREE.InstancedMesh(rockGeometry, createSurfaceRockMaterial(), ROCK_FIELD.maximumInstances),
        config: ROCK_FIELD,
        instances: [],
        dark: new THREE.Color(0xb96f52),
        light: new THREE.Color(0xeaaa80),
        maxAltitudeM: 1_500,
        groundingCursor: 0,
        groundingRefreshBudget: ROCK_GROUNDING_REFRESH_BUDGET,
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
    this.rockSkyFill.visible = visible;
    this.rockSkyFill.intensity = 0.32 + 0.26 * (1 - clamp(altitudeM / SURFACE_DETAIL_MAX_ALTITUDE_M, 0, 1));
    for (const field of this.fields) field.mesh.visible = altitudeM <= field.maxAltitudeM;
    if (!visible) return;

    const cameraDirection = normalize3(cameraDirectionInput);
    // HemisphereLight uses its position as the sky direction. Keep that axis
    // aligned with local Mars-up instead of the planet's global Y axis.
    this.rockSkyFill.position.set(cameraDirection.x, cameraDirection.y, cameraDirection.z);
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
    else this.refreshGrounding();

    this.cameraAbsolute.set(cameraAbsoluteInput.x, cameraAbsoluteInput.y, cameraAbsoluteInput.z);
    for (const field of this.fields) {
      if (!field.mesh.visible) continue;
      for (let index = 0; index < field.instances.length; index += 1) {
        const instance = field.instances[index];
        this.localPosition.copy(instance.absolute).sub(this.cameraAbsolute);
        this.matrix.compose(
          this.localPosition,
          instance.rotation,
          instance.grounded ? instance.scale : this.hiddenScale,
        );
        field.mesh.setMatrixAt(index, this.matrix);
      }
      field.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private groundInstance(field: SurfaceField, index: number) {
    const instance = field.instances[index];
    const support = this.sampleVisibleSurface(instance.point.direction);
    if (!support) {
      instance.grounded = false;
      return;
    }

    const placement = calculateSurfaceRockPlacement(instance.point, support);
    instance.absolute.set(placement.absolute.x, placement.absolute.y, placement.absolute.z);
    this.direction.set(placement.normal.x, placement.normal.y, placement.normal.z).normalize();
    this.align.setFromUnitVectors(this.modelUp, this.direction);
    this.twist.setFromAxisAngle(this.direction, instance.point.yawRad);
    instance.rotation.copy(this.twist).multiply(this.align);
    instance.scale.set(placement.scale.x, placement.scale.y, placement.scale.z);
    instance.grounded = true;
  }

  private refreshGrounding() {
    for (const field of this.fields) {
      const count = field.instances.length;
      if (count === 0) continue;
      const refreshCount = Math.min(field.groundingRefreshBudget, count);
      for (let offset = 0; offset < refreshCount; offset += 1) {
        this.groundInstance(field, field.groundingCursor);
        field.groundingCursor = (field.groundingCursor + 1) % count;
      }
    }
  }

  private rebuild(centerDirection: Vec3) {
    this.anchorDirection.set(centerDirection.x, centerDirection.y, centerDirection.z).normalize();
    this.hasAnchor = true;

    for (const field of this.fields) {
      const points = generateSurfaceScatter(centerDirection, field.config);
      field.instances = points.map((point, index) => {
        this.colour.copy(field.dark).lerp(field.light, 0.18 + point.tint * 0.72);
        field.mesh.setColorAt(index, this.colour);
        return {
          point,
          absolute: new THREE.Vector3(),
          rotation: new THREE.Quaternion(),
          scale: new THREE.Vector3(),
          grounded: false,
        };
      });
      field.groundingCursor = 0;
      for (let index = 0; index < field.instances.length; index += 1) this.groundInstance(field, index);
      field.mesh.count = field.instances.length;
      if (field.mesh.instanceColor) field.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    this.rockSkyFill.removeFromParent();
    for (const field of this.fields) {
      field.mesh.removeFromParent();
      field.mesh.geometry.dispose();
      field.mesh.material.map?.dispose();
      field.mesh.material.normalMap?.dispose();
      field.mesh.material.roughnessMap?.dispose();
      field.mesh.material.dispose();
    }
  }
}
