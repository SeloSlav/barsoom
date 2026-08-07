import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  MARS_ORBITER_CATALOG,
  type MarsOrbiterName,
  type MarsSkyState,
  writeMarsOrbiterOrbitPath,
} from "../ephemeris";
import type { Vec3 } from "../types";

const ORBITAL_LAYER = 2;
const ORBIT_TRACK_POINTS = 193;

type TrackVisual = {
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  positions: Float32Array;
};

function disposeModel(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of meshMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  root.removeFromParent();
}

export class OrbiterRenderer {
  private readonly tracksRoot = new THREE.Group();
  private readonly modelRoot = new THREE.Group();
  private readonly tracks = new Map<MarsOrbiterName, TrackVisual>();
  private readonly loadingMarker: THREE.Mesh<THREE.OctahedronGeometry, THREE.MeshBasicMaterial>;
  private readonly inward = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly orientation = new THREE.Matrix4();
  private selected: MarsOrbiterName | null = null;
  private model: THREE.Object3D | null = null;
  private loadRevision = 0;
  private lastTrackEpochMs = -Infinity;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    private readonly onAssetError: (message: string) => void,
  ) {
    camera.layers.enable(ORBITAL_LAYER);
    this.tracksRoot.name = "Current Mars spacecraft osculating orbit tracks";
    this.modelRoot.name = "Selected physical-scale Mars orbiter";
    this.modelRoot.layers.set(ORBITAL_LAYER);
    scene.add(this.tracksRoot, this.modelRoot);

    for (const orbit of MARS_ORBITER_CATALOG) {
      const positions = new Float32Array(ORBIT_TRACK_POINTS * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({
        color: orbit.colour,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        depthTest: true,
      });
      const line = new THREE.Line(geometry, material);
      line.name = `${orbit.shortName} / NASA-JPL Horizons osculating orbit`;
      line.layers.set(ORBITAL_LAYER);
      line.frustumCulled = false;
      line.renderOrder = 7_500;
      this.tracksRoot.add(line);
      this.tracks.set(orbit.name, { line, positions });
    }

    this.loadingMarker = new THREE.Mesh(
      new THREE.OctahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xb8e6ff,
        transparent: true,
        opacity: 0.55,
        wireframe: true,
        depthWrite: false,
      }),
    );
    this.loadingMarker.name = "Orbiter model acquisition marker";
    this.loadingMarker.layers.set(ORBITAL_LAYER);
    this.loadingMarker.visible = false;
    this.modelRoot.add(this.loadingMarker);
  }

  select(name: MarsOrbiterName | null) {
    if (name === this.selected) return;
    this.selected = name;
    this.loadRevision += 1;
    this.clearModel();
    this.loadingMarker.visible = name !== null;
    if (!name) return;
    const specification = MARS_ORBITER_CATALOG.find((candidate) => candidate.name === name);
    if (!specification) return;
    this.loadingMarker.scale.setScalar(specification.modelMaxDimensionM * 0.42);
    const revision = this.loadRevision;
    void new GLTFLoader().loadAsync(specification.modelPath).then((gltf) => {
      if (revision !== this.loadRevision || this.selected !== name) {
        disposeModel(gltf.scene);
        return;
      }
      gltf.scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      const size = bounds.getSize(new THREE.Vector3());
      const sourceMaxDimension = Math.max(size.x, size.y, size.z);
      if (!Number.isFinite(sourceMaxDimension) || sourceMaxDimension <= 1e-6) {
        disposeModel(gltf.scene);
        throw new RangeError(`${name} model has no measurable dimensions.`);
      }
      const scale = specification.modelMaxDimensionM / sourceMaxDimension;
      const center = bounds.getCenter(new THREE.Vector3());
      const normalized = new THREE.Group();
      gltf.scene.scale.setScalar(scale);
      gltf.scene.position.addScaledVector(center, -scale);
      gltf.scene.traverse((object) => {
        object.layers.set(ORBITAL_LAYER);
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = false;
        object.receiveShadow = false;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if ("envMapIntensity" in material) material.envMapIntensity = 0.55;
        }
      });
      normalized.add(gltf.scene);
      normalized.name = `${specification.shortName} / official optimized NASA model / physical scale`;
      this.model = normalized;
      this.modelRoot.add(normalized);
      this.loadingMarker.visible = false;
    }).catch((error) => {
      if (revision !== this.loadRevision || this.selected !== name) return;
      console.error(`Unable to load the official ${name} model`, error);
      this.loadingMarker.visible = true;
      this.onAssetError(`The official ${name} model could not be loaded. Orbital tracking remains available.`);
    });
  }

  update(sky: MarsSkyState, cameraAbsolute: Vec3, observingMars: boolean) {
    this.tracksRoot.visible = observingMars;
    this.tracksRoot.position.set(-cameraAbsolute.x, -cameraAbsolute.y, -cameraAbsolute.z);
    const epochMs = sky.utc.getTime();
    if (Math.abs(epochMs - this.lastTrackEpochMs) >= 5_000) {
      for (const orbiter of sky.orbiters) {
        const track = this.tracks.get(orbiter.name);
        if (!track) continue;
        writeMarsOrbiterOrbitPath(orbiter, sky.inertialToMarsFixed, track.positions);
        const attribute = track.line.geometry.getAttribute("position") as THREE.BufferAttribute;
        attribute.needsUpdate = true;
        track.line.geometry.computeBoundingSphere();
      }
      this.lastTrackEpochMs = epochMs;
    }

    const selected = this.selected
      ? sky.orbiters.find((candidate) => candidate.name === this.selected)
      : null;
    this.modelRoot.visible = selected !== null;
    if (!selected) return;
    this.modelRoot.position.set(
      selected.positionM.x - cameraAbsolute.x,
      selected.positionM.y - cameraAbsolute.y,
      selected.positionM.z - cameraAbsolute.z,
    );
    this.inward.set(-selected.positionM.x, -selected.positionM.y, -selected.positionM.z).normalize();
    this.normal.set(selected.orbitNormal.x, selected.orbitNormal.y, selected.orbitNormal.z).normalize();
    this.tangent.crossVectors(this.normal, this.inward).normalize();
    this.orientation.makeBasis(this.tangent, this.normal, this.inward);
    this.modelRoot.quaternion.setFromRotationMatrix(this.orientation);
    this.loadingMarker.rotation.x += 0.008;
    this.loadingMarker.rotation.y += 0.013;
  }

  private clearModel() {
    if (!this.model) return;
    disposeModel(this.model);
    this.model = null;
  }

  dispose() {
    this.loadRevision += 1;
    this.clearModel();
    for (const track of this.tracks.values()) {
      track.line.geometry.dispose();
      track.line.material.dispose();
      track.line.removeFromParent();
    }
    this.tracks.clear();
    this.loadingMarker.geometry.dispose();
    this.loadingMarker.material.dispose();
    this.loadingMarker.removeFromParent();
    this.tracksRoot.removeFromParent();
    this.modelRoot.removeFromParent();
  }
}
