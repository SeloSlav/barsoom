import * as THREE from "three";
import { MARS_REFERENCE_RADIUS_M } from "../constants";
import type { MarsMoonState, MarsSkyState } from "../ephemeris";
import type { Vec3 } from "../types";

const MOON_LAYER = 2;
const TEXTURE_WIDTH = 1024;
const TEXTURE_HEIGHT = 512;

type MoonVisual = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  baseColour: THREE.Color;
};

function hash(x: number, y: number, seed: number) {
  let value = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(y + seed, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
}

function smooth(value: number) {
  return value * value * (3 - 2 * value);
}

function valueNoise(x: number, y: number, frequency: number, seed: number) {
  const sampleX = x * frequency;
  const sampleY = y * frequency;
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const tx = smooth(sampleX - x0);
  const ty = smooth(sampleY - y0);
  const x1 = (x0 + 1) % frequency;
  const y1 = Math.min(frequency, y0 + 1);
  const wrappedX0 = ((x0 % frequency) + frequency) % frequency;
  const a = THREE.MathUtils.lerp(hash(wrappedX0, y0, seed), hash(x1, y0, seed), tx);
  const b = THREE.MathUtils.lerp(hash(wrappedX0, y1, seed), hash(x1, y1, seed), tx);
  return THREE.MathUtils.lerp(a, b, ty);
}

function angularDistance(longitude: number, latitude: number, craterLongitude: number, craterLatitude: number) {
  return Math.acos(THREE.MathUtils.clamp(
    Math.sin(latitude) * Math.sin(craterLatitude)
      + Math.cos(latitude) * Math.cos(craterLatitude) * Math.cos(longitude - craterLongitude),
    -1,
    1,
  ));
}

function createMoonTexture(name: MarsMoonState["name"], albedo: number) {
  const seed = name === "Phobos" ? 0x50484f42 : 0x4445494d;
  const pixels = new Uint8Array(TEXTURE_WIDTH * TEXTURE_HEIGHT * 4);
  const craters = name === "Phobos"
    ? [
        { longitude: 0.08, latitude: 0.16, radius: 0.47, depth: 0.42 }, // Stickney
        { longitude: -1.9, latitude: -0.22, radius: 0.16, depth: 0.18 },
        { longitude: 2.25, latitude: 0.58, radius: 0.11, depth: 0.15 },
      ]
    : [
        { longitude: -0.7, latitude: 0.31, radius: 0.2, depth: 0.16 },
        { longitude: 1.55, latitude: -0.44, radius: 0.14, depth: 0.1 },
      ];
  for (let py = 0; py < TEXTURE_HEIGHT; py += 1) {
    const latitude = Math.PI * (0.5 - (py + 0.5) / TEXTURE_HEIGHT);
    for (let px = 0; px < TEXTURE_WIDTH; px += 1) {
      const longitude = Math.PI * 2 * ((px + 0.5) / TEXTURE_WIDTH - 0.5);
      let terrain = 0;
      let amplitude = 0.58;
      for (let octave = 0; octave < 5; octave += 1) {
        terrain += (
          valueNoise(px / TEXTURE_WIDTH, py / TEXTURE_HEIGHT, 8 << octave, seed + octave * 997) - 0.5
        ) * amplitude;
        amplitude *= 0.5;
      }
      let craterShade = 0;
      for (const crater of craters) {
        const distance = angularDistance(longitude, latitude, crater.longitude, crater.latitude) / crater.radius;
        if (distance < 0.78) craterShade -= (1 - smooth(distance / 0.78)) * crater.depth;
        else if (distance < 1.12) {
          craterShade += Math.sin((distance - 0.78) / 0.34 * Math.PI) * crater.depth * 0.52;
        }
      }
      const grooves = name === "Phobos"
        ? Math.max(0, Math.cos((longitude * 7.5 + latitude * 2.2) * Math.PI)) ** 18 * 0.1
        : 0;
      const brightness = THREE.MathUtils.clamp(0.72 + terrain + craterShade - grooves, 0.22, 1.28);
      const spectral = albedo / 0.07;
      const offset = (py * TEXTURE_WIDTH + px) * 4;
      pixels[offset] = Math.round(THREE.MathUtils.clamp(74 * spectral * brightness, 0, 255));
      pixels[offset + 1] = Math.round(THREE.MathUtils.clamp(64 * spectral * brightness, 0, 255));
      pixels[offset + 2] = Math.round(THREE.MathUtils.clamp(58 * spectral * brightness, 0, 255));
      pixels[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, TEXTURE_WIDTH, TEXTURE_HEIGHT, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  texture.name = `${name} 1K procedural albedo`;
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
