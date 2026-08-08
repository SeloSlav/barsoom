import * as THREE from "three";
import { MARS_REFERENCE_RADIUS_M } from "../constants";
import { clamp, normalize3 } from "../math";
import { spatialSeed } from "../noise";
import type { Vec3 } from "../types";

const TAU = Math.PI * 2;
const SURFACE_DETAIL_MAX_ALTITUDE_M = 8_000;
const SURFACE_DETAIL_REBUILD_DISTANCE_M = 180;
const BOULDER_GROUNDING_REFRESH_BUDGET = 160;
const ROCK_GROUNDING_REFRESH_BUDGET = 480;
const CLAST_GROUNDING_REFRESH_BUDGET = 640;

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
    roughness: 0.94,
    metalness: 0,
    flatShading: true,
    vertexColors: true,
    // A restrained texture-coloured bounce keeps shadowed faces legible
    // without making the separate rock layer glow against the regolith.
    emissive: 0xffffff,
    emissiveMap: diffuse,
    emissiveIntensity: 0.20,
  });
}

const BOULDER_FIELD: SurfaceScatterConfig = {
  radiusM: 6_000,
  spacingM: 145,
  density: 0.32,
  minimumSizeM: 0.55,
  maximumSizeM: 8.5,
  maximumInstances: 2_200,
  seedSalt: 0x626f756c,
};

const ROCK_FIELD: SurfaceScatterConfig = {
  radiusM: 400,
  spacingM: 10,
  density: 0.62,
  minimumSizeM: 0.065,
  maximumSizeM: 0.95,
  maximumInstances: 3_400,
  seedSalt: 0x726f636b,
};

const CLAST_FIELD: SurfaceScatterConfig = {
  radiusM: 120,
  spacingM: 3.2,
  density: 0.72,
  minimumSizeM: 0.018,
  maximumSizeM: 0.14,
  maximumInstances: 4_000,
  seedSalt: 0x636c6173,
};

function createIrregularRockGeometry(kind: "boulder" | "rock" | "clast") {
  const geometry = kind === "boulder"
    ? new THREE.DodecahedronGeometry(1, 1)
    : new THREE.IcosahedronGeometry(1, kind === "rock" ? 1 : 0);
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const seed = kind === "boulder" ? 1.73 : kind === "rock" ? 4.91 : 8.37;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const ridge = Math.sin(x * 4.7 + seed) * Math.sin(y * 3.1 - seed * 0.7) * Math.sin(z * 5.3 + seed * 1.4);
    const scale = 0.91 + ridge * 0.13 + Math.sin((x + z) * 7.9 - seed) * 0.045;
    positions.setXYZ(index, x * scale, y * scale * (kind === "clast" ? 0.68 : 0.82), z * scale);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

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
  // Windblown dust commonly mantles the base of Martian clasts. Vary the
  // burial depth with the stable per-rock tint seed so the field does not sit
  // on one mathematically perfect contact plane.
  const exposedCenterM = scale.y * (0.12 + point.tint * 0.40);
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
  requiredDetailLevel: 1 | 2;
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
  private detailLevel: 0 | 1 | 2 = 2;

  constructor(
    scene: THREE.Scene,
    private readonly sampleVisibleSurface: (direction: Vec3) => SurfaceRockSupport | null,
  ) {
    const boulderGeometry = createIrregularRockGeometry("boulder");
    const rockGeometry = createIrregularRockGeometry("rock");
    const clastGeometry = createIrregularRockGeometry("clast");
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
        dark: new THREE.Color(0x725449),
        light: new THREE.Color(0xb9856c),
        maxAltitudeM: SURFACE_DETAIL_MAX_ALTITUDE_M,
        groundingCursor: 0,
        groundingRefreshBudget: BOULDER_GROUNDING_REFRESH_BUDGET,
        requiredDetailLevel: 1,
      },
      {
        mesh: new THREE.InstancedMesh(rockGeometry, createSurfaceRockMaterial(), ROCK_FIELD.maximumInstances),
        config: ROCK_FIELD,
        instances: [],
        dark: new THREE.Color(0x684b42),
        light: new THREE.Color(0xac7762),
        maxAltitudeM: 1_500,
        groundingCursor: 0,
        groundingRefreshBudget: ROCK_GROUNDING_REFRESH_BUDGET,
        requiredDetailLevel: 2,
      },
      {
        mesh: new THREE.InstancedMesh(clastGeometry, createSurfaceRockMaterial(), CLAST_FIELD.maximumInstances),
        config: CLAST_FIELD,
        instances: [],
        dark: new THREE.Color(0x5c4942),
        light: new THREE.Color(0x98705e),
        maxAltitudeM: 220,
        groundingCursor: 0,
        groundingRefreshBudget: CLAST_GROUNDING_REFRESH_BUDGET,
        requiredDetailLevel: 2,
      },
    ];

    for (const [index, field] of this.fields.entries()) {
      field.mesh.name = index === 0
        ? "Mars deterministic boulder field"
        : index === 1
          ? "Mars deterministic rock field"
          : "Mars deterministic clast field";
      field.mesh.count = 0;
      field.mesh.visible = false;
      field.mesh.frustumCulled = false;
      field.mesh.castShadow = index === 0;
      field.mesh.receiveShadow = true;
      field.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(field.mesh);
    }
  }

  update(
    cameraAbsoluteInput: Vec3,
    cameraDirectionInput: Vec3,
    altitudeM: number,
    detailLevel: 0 | 1 | 2 = 2,
  ) {
    if (detailLevel !== this.detailLevel) {
      this.detailLevel = detailLevel;
      this.hasAnchor = false;
      for (const field of this.fields) {
        if (field.requiredDetailLevel > detailLevel) {
          field.instances = [];
          field.mesh.count = 0;
          field.mesh.visible = false;
        }
      }
    }
    const visible = detailLevel > 0 && altitudeM <= SURFACE_DETAIL_MAX_ALTITUDE_M;
    this.rockSkyFill.visible = visible;
    this.rockSkyFill.intensity = 0.32 + 0.26 * (1 - clamp(altitudeM / SURFACE_DETAIL_MAX_ALTITUDE_M, 0, 1));
    for (const field of this.fields) {
      field.mesh.visible = field.requiredDetailLevel <= detailLevel && altitudeM <= field.maxAltitudeM;
    }
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
      if (field.requiredDetailLevel > this.detailLevel) {
        field.instances = [];
        field.mesh.count = 0;
        continue;
      }
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
