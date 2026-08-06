import * as THREE from "three";
import { MARS_REFERENCE_RADIUS_M } from "../constants";
import type { MarsMoonState, MarsSkyState } from "../ephemeris";
import type { Vec3 } from "../types";

const MOON_LAYER = 2;

const MOON_ALBEDO_PATHS: Record<MarsMoonState["name"], string> = {
  Phobos: "/textures/phobos-albedo.png?revision=photoreal-2026-08",
  Deimos: "/textures/deimos-albedo.png?revision=photoreal-2026-08",
};

type MoonVisual = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  baseColour: THREE.Color;
};

function smooth(value: number) {
  return value * value * (3 - 2 * value);
}

function createMoonTexture(name: MarsMoonState["name"], albedo: number) {
  let texture: THREE.Texture;
  if (typeof document === "undefined") {
    const spectral = albedo / 0.07;
    const fallback = new Uint8Array([
      Math.round(THREE.MathUtils.clamp(74 * spectral, 0, 255)),
      Math.round(THREE.MathUtils.clamp(64 * spectral, 0, 255)),
      Math.round(THREE.MathUtils.clamp(58 * spectral, 0, 255)),
      255,
    ]);
    texture = new THREE.DataTexture(fallback, 1, 1, THREE.RGBAFormat);
    texture.needsUpdate = true;
  } else {
    texture = new THREE.TextureLoader().load(MOON_ALBEDO_PATHS[name]);
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.name = `${name} photorealistic equirectangular albedo`;
  return texture;
}

function createIrregularGeometry(name: MarsMoonState["name"]) {
  const geometry = new THREE.SphereGeometry(1, 96, 64);
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const direction = new THREE.Vector3();
  const stickney = new THREE.Vector3(0.98, 0.12, 0.16).normalize();
  for (let index = 0; index < positions.count; index += 1) {
    direction.fromBufferAttribute(positions, index).normalize();
    const wave = (
      Math.sin(direction.x * 9.7 + direction.z * 4.1)
      + Math.sin(direction.y * 14.3 - direction.x * 3.7)
      + Math.cos(direction.z * 18.1 + direction.y * 5.3)
    ) / 3;
    let radius = 1 + wave * (name === "Phobos" ? 0.048 : 0.027);
    if (name === "Phobos") {
      const craterDistance = Math.acos(THREE.MathUtils.clamp(direction.dot(stickney), -1, 1));
      if (craterDistance < 0.46) {
        const normalized = craterDistance / 0.46;
        radius += normalized < 0.78
          ? -0.12 * (1 - smooth(normalized / 0.78))
          : 0.045 * Math.sin((normalized - 0.78) / 0.22 * Math.PI);
      }
    }
    positions.setXYZ(index, direction.x * radius, direction.y * radius, direction.z * radius);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function eclipseFactor(moon: MarsMoonState, sky: MarsSkyState) {
  const sun = sky.sunDirection;
  const alongSun = moon.positionM.x * sun.x + moon.positionM.y * sun.y + moon.positionM.z * sun.z;
  if (alongSun >= 0) return 1;
  const perpendicular = Math.hypot(
    moon.positionM.x - sun.x * alongSun,
    moon.positionM.y - sun.y * alongSun,
    moon.positionM.z - sun.z * alongSun,
  );
  const umbraRadius = Math.max(0, MARS_REFERENCE_RADIUS_M + alongSun * Math.tan(sky.sunAngularRadiusRad));
  const moonRadius = Math.max(...moon.semiAxesM);
  return THREE.MathUtils.smoothstep(perpendicular, umbraRadius - moonRadius, umbraRadius + moonRadius);
}

export class MoonRenderer {
  private readonly visuals = new Map<MarsMoonState["name"], MoonVisual>();
  private readonly sunLight = new THREE.DirectionalLight(0xfff1d7, 3.6);
  private readonly sunTarget = new THREE.Object3D();
  private readonly ambientLight = new THREE.AmbientLight(0x59606d, 0.035);
  private readonly radial = new THREE.Vector3();
  private readonly inward = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly orientation = new THREE.Matrix4();
  private readonly sun = new THREE.Vector3();

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, moons: MarsMoonState[]) {
    camera.layers.enable(MOON_LAYER);
    this.sunLight.layers.set(MOON_LAYER);
    this.sunTarget.layers.set(MOON_LAYER);
    this.ambientLight.layers.set(MOON_LAYER);
    this.sunLight.target = this.sunTarget;
    scene.add(this.sunTarget, this.sunLight, this.ambientLight);
    for (const moon of moons) {
      const map = createMoonTexture(moon.name, moon.albedo);
      const material = new THREE.MeshStandardMaterial({ map, roughness: 0.96, metalness: 0 });
      const mesh = new THREE.Mesh(createIrregularGeometry(moon.name), material);
      mesh.name = `${moon.name} / physical scale / synchronous rotation`;
      mesh.layers.set(MOON_LAYER);
      mesh.scale.set(...moon.semiAxesM);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      scene.add(mesh);
      this.visuals.set(moon.name, { mesh, baseColour: new THREE.Color(1, 1, 1) });
    }
  }

  update(sky: MarsSkyState, cameraAbsolute: Vec3) {
    this.sunTarget.position.set(-cameraAbsolute.x, -cameraAbsolute.y, -cameraAbsolute.z);
    this.sun.set(sky.sunDirection.x, sky.sunDirection.y, sky.sunDirection.z);
    this.sunLight.position.copy(this.sunTarget.position).addScaledVector(this.sun, 10_000_000);
    for (const moon of sky.moons) {
      const visual = this.visuals.get(moon.name);
      if (!visual) continue;
      visual.mesh.position.set(
        moon.positionM.x - cameraAbsolute.x,
        moon.positionM.y - cameraAbsolute.y,
        moon.positionM.z - cameraAbsolute.z,
      );
      this.radial.set(moon.positionM.x, moon.positionM.y, moon.positionM.z).normalize();
      this.inward.copy(this.radial).multiplyScalar(-1);
      this.normal.set(moon.orbitNormal.x, moon.orbitNormal.y, moon.orbitNormal.z).normalize();
      this.tangent.crossVectors(this.normal, this.inward).normalize();
      this.normal.crossVectors(this.inward, this.tangent).normalize();
      this.orientation.makeBasis(this.inward, this.tangent, this.normal);
      visual.mesh.quaternion.setFromRotationMatrix(this.orientation);
      const illumination = 0.025 + 0.975 * eclipseFactor(moon, sky);
      visual.mesh.material.color.copy(visual.baseColour).multiplyScalar(illumination);
      visual.mesh.visible = true;
    }
    this.sunTarget.updateMatrixWorld(true);
    this.sunLight.updateMatrixWorld(true);
  }

  dispose() {
    for (const visual of this.visuals.values()) {
      visual.mesh.geometry.dispose();
      visual.mesh.material.map?.dispose();
      visual.mesh.material.dispose();
      visual.mesh.removeFromParent();
    }
    this.visuals.clear();
    this.sunLight.removeFromParent();
    this.sunTarget.removeFromParent();
    this.ambientLight.removeFromParent();
  }
}
