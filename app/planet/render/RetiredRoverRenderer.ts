import * as THREE from "three";
import { MARS_REFERENCE_RADIUS_M } from "../constants";
import {
  RETIRED_ROVER_SITES,
  roverModelBasis,
  roverSiteDirection,
  type RetiredRoverModel,
  type RetiredRoverSite,
} from "../roverSites";
import type { Vec3 } from "../types";

const ROVER_RENDER_DISTANCE_M = 50_000;
const ROVER_RENDER_MAX_ALTITUDE_M = 30_000;

type RoverSurfaceSupport = {
  radiusM: number;
  normal: Vec3;
};

type RoverMaterials = {
  structure: THREE.MeshStandardMaterial;
  warmMetal: THREE.MeshStandardMaterial;
  solar: THREE.MeshStandardMaterial;
  wheel: THREE.MeshStandardMaterial;
  lens: THREE.MeshStandardMaterial;
};

type RoverVisual = {
  site: RetiredRoverSite;
  direction: THREE.Vector3;
  root: THREE.Group;
};

function createMaterials(): RoverMaterials {
  return {
    structure: new THREE.MeshStandardMaterial({
      color: 0xc3b9a9,
      metalness: 0.7,
      roughness: 0.48,
      emissive: 0x261b14,
      emissiveIntensity: 0.16,
    }),
    warmMetal: new THREE.MeshStandardMaterial({
      color: 0xa66f42,
      metalness: 0.58,
      roughness: 0.6,
      emissive: 0x24150c,
      emissiveIntensity: 0.15,
    }),
    solar: new THREE.MeshStandardMaterial({
      color: 0x172d3c,
      metalness: 0.32,
      roughness: 0.38,
      emissive: 0x07131b,
      emissiveIntensity: 0.25,
    }),
    wheel: new THREE.MeshStandardMaterial({
      color: 0x4b4640,
      metalness: 0.72,
      roughness: 0.68,
    }),
    lens: new THREE.MeshStandardMaterial({
      color: 0x161f25,
      metalness: 0.2,
      roughness: 0.2,
      emissive: 0x18384a,
      emissiveIntensity: 0.26,
    }),
  };
}

function addBox(
  root: THREE.Group,
  name: string,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...position);
  root.add(mesh);
  return mesh;
}

function addCylinder(
  root: THREE.Group,
  name: string,
  radius: number,
  length: number,
  position: [number, number, number],
  material: THREE.Material,
  axis: "x" | "y" | "z" = "y",
  radialSegments = 12,
) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, radialSegments), material);
  mesh.name = name;
  mesh.position.set(...position);
  if (axis === "x") mesh.rotation.z = Math.PI * 0.5;
  if (axis === "z") mesh.rotation.x = Math.PI * 0.5;
  root.add(mesh);
  return mesh;
}

function addWheelSet(
  root: THREE.Group,
  positions: readonly number[],
  halfTrackM: number,
  centerHeightM: number,
  radiusM: number,
  widthM: number,
  materials: RoverMaterials,
) {
  for (const side of [-1, 1] as const) {
    for (const [index, z] of positions.entries()) {
      const x = side * halfTrackM;
      addCylinder(root, `Wheel ${side < 0 ? "left" : "right"} ${index + 1}`, radiusM, widthM, [x, centerHeightM, z], materials.wheel, "x", 16);
      const arm = addBox(root, "Rocker-bogie suspension arm", [0.045, 0.045, Math.abs(z) + 0.22], [side * (halfTrackM - widthM * 0.55), centerHeightM + radiusM * 0.62, z * 0.48], materials.warmMetal);
      arm.rotation.x = z * -0.12;
    }
  }
}

function addSolarGrid(panel: THREE.Mesh, widthM: number, lengthM: number, root: THREE.Group) {
  const lineMaterial = new THREE.MeshBasicMaterial({ color: 0x6d8790, transparent: true, opacity: 0.38 });
  for (let index = -2; index <= 2; index += 1) {
    addBox(
      root,
      "Solar-cell grid",
      [0.008, 0.006, lengthM * 0.92],
      [panel.position.x + index * widthM / 5.5, panel.position.y + 0.018, panel.position.z],
      lineMaterial,
    );
  }
}

function buildSojourner(materials: RoverMaterials) {
  const root = new THREE.Group();
  root.name = "Sojourner rover reconstruction";
  addWheelSet(root, [-0.23, 0, 0.23], 0.29, 0.07, 0.065, 0.055, materials);
  addBox(root, "Sojourner chassis", [0.42, 0.16, 0.6], [0, 0.2, 0], materials.warmMetal);
  const panel = addBox(root, "Sojourner solar deck", [0.48, 0.025, 0.66], [0, 0.31, 0], materials.solar);
  addSolarGrid(panel, 0.48, 0.66, root);
  addBox(root, "Sojourner front camera bar", [0.31, 0.07, 0.06], [0, 0.31, 0.33], materials.structure);
  addCylinder(root, "Sojourner left camera", 0.025, 0.045, [-0.095, 0.32, 0.37], materials.lens, "z", 10);
  addCylinder(root, "Sojourner right camera", 0.025, 0.045, [0.095, 0.32, 0.37], materials.lens, "z", 10);
  return root;
}

function buildMer(materials: RoverMaterials) {
  const root = new THREE.Group();
  root.name = "Mars Exploration Rover reconstruction";
  addWheelSet(root, [-0.67, 0, 0.67], 0.89, 0.25, 0.24, 0.16, materials);
  addBox(root, "MER warm electronics box", [1.05, 0.42, 1.28], [0, 0.63, 0], materials.warmMetal);
  addBox(root, "MER equipment deck", [1.28, 0.12, 1.48], [0, 0.9, 0], materials.structure);
  for (const side of [-1, 1] as const) {
    const inner = addBox(root, "MER inner solar wing", [0.74, 0.045, 1.16], [side * 0.78, 0.98, -0.04], materials.solar);
    const outer = addBox(root, "MER outer solar wing", [0.6, 0.045, 0.96], [side * 1.43, 0.96, -0.02], materials.solar);
    inner.rotation.z = side * -0.04;
    outer.rotation.z = side * -0.08;
    addSolarGrid(inner, 0.74, 1.16, root);
    addSolarGrid(outer, 0.6, 0.96, root);
  }
  addCylinder(root, "MER panoramic camera mast", 0.045, 1.05, [0, 1.48, 0.22], materials.structure, "y", 10);
  addBox(root, "MER Pancam head", [0.45, 0.18, 0.2], [0, 2.04, 0.22], materials.structure);
  addCylinder(root, "MER left Pancam", 0.052, 0.075, [-0.13, 2.05, 0.34], materials.lens, "z", 12);
  addCylinder(root, "MER right Pancam", 0.052, 0.075, [0.13, 2.05, 0.34], materials.lens, "z", 12);
  addCylinder(root, "MER high-gain antenna", 0.2, 0.035, [0.27, 1.18, -0.24], materials.structure, "y", 20);
  const arm = addBox(root, "MER instrument deployment arm", [0.085, 0.085, 0.84], [0.38, 0.47, 0.62], materials.structure);
  arm.rotation.x = -0.45;
  addCylinder(root, "MER instrument turret", 0.15, 0.12, [0.38, 0.29, 1.0], materials.warmMetal, "z", 14);
  return root;
}

export function createRetiredRoverModel(model: RetiredRoverModel, materials = createMaterials()) {
  const root = model === "sojourner" ? buildSojourner(materials) : buildMer(materials);
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
  return root;
}

export class RetiredRoverRenderer {
  private readonly materials = createMaterials();
  private readonly visuals: RoverVisual[];
  private readonly cameraAbsolute = new THREE.Vector3();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly absolute = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly orientation = new THREE.Matrix4();

  constructor(
    scene: THREE.Scene,
    private readonly sampleVisibleSurface: (direction: Vec3) => RoverSurfaceSupport | null,
  ) {
    this.visuals = RETIRED_ROVER_SITES.map((site) => {
      const direction = roverSiteDirection(site);
      const root = createRetiredRoverModel(site.model, this.materials);
      root.name = `${site.name} retired rover at ${site.finalSite}`;
      root.visible = false;
      scene.add(root);
      return {
        site,
        direction: new THREE.Vector3(direction.x, direction.y, direction.z),
        root,
      };
    });
  }

  update(cameraAbsoluteInput: Vec3, altitudeM: number) {
    this.cameraAbsolute.set(cameraAbsoluteInput.x, cameraAbsoluteInput.y, cameraAbsoluteInput.z);
    this.cameraDirection.copy(this.cameraAbsolute).normalize();
    for (const visual of this.visuals) {
      const angularDistance = Math.acos(THREE.MathUtils.clamp(
        this.cameraDirection.dot(visual.direction),
        -1,
        1,
      ));
      const closeEnough = altitudeM <= ROVER_RENDER_MAX_ALTITUDE_M &&
        angularDistance * MARS_REFERENCE_RADIUS_M <= ROVER_RENDER_DISTANCE_M;
      if (!closeEnough) {
        visual.root.visible = false;
        continue;
      }
      const support = this.sampleVisibleSurface(visual.direction);
      if (!support) {
        visual.root.visible = false;
        continue;
      }
      const basis = roverModelBasis(visual.site, support.normal);
      this.right.set(basis.right.x, basis.right.y, basis.right.z);
      this.up.set(basis.up.x, basis.up.y, basis.up.z);
      this.forward.set(basis.forward.x, basis.forward.y, basis.forward.z);
      this.orientation.makeBasis(this.right, this.up, this.forward);
      visual.root.quaternion.setFromRotationMatrix(this.orientation);
      this.absolute.copy(visual.direction).multiplyScalar(support.radiusM);
      visual.root.position.copy(this.absolute).sub(this.cameraAbsolute);
      visual.root.visible = true;
    }
  }

  dispose() {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const visual of this.visuals) {
      visual.root.removeFromParent();
      visual.root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
        meshMaterials.forEach((material) => materials.add(material));
      });
    }
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  }
}
