import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  MARS_REFERENCE_RADIUS_M,
  MARS_SURFACE_GRAVITY_M_S2,
} from "./constants";
import { clamp } from "./math";
import type { TraverseSurfaceSample } from "./SurfaceTraverseController";
import type { Vec3 } from "./types";

const SHIP_GROUND_CLEARANCE_M = 1.15;
const SHIP_SPAWN_FORWARD_M = 18;
const SHIP_SPAWN_RIGHT_M = 10;
const SHIP_THRUST_M_S2 = 58;
const SHIP_BOOST_THRUST_M_S2 = 180;
const SHIP_MANEUVER_THRUST_M_S2 = 34;
const SHIP_MAX_SPEED_M_S = 12_000;
const SHIP_TRAIL_LIFETIME_S = 4.8;
const SHIP_TRAIL_POINT_INTERVAL_S = 0.035;
const SHIP_TRAIL_MAX_POINTS = 240;
const SHIP_STEER_DEAD_ZONE = 0.055;
const SHIP_MODEL_LENGTH_M = 9.2;

export const SHIP_BOARD_DISTANCE_M = 5.5;
export const SURFACE_SPACESHIP_MODEL_PATH = "/models/surface-spaceship.glb";

export type SpaceshipFlightInput = {
  throttle: number;
  strafe: number;
  lift: number;
  roll: number;
  boost: boolean;
  aimX: number;
  aimY: number;
};

type TrailPoint = {
  left: THREE.Vector3;
  right: THREE.Vector3;
  lifeS: number;
};

export function spaceshipSteerAmount(value: number, deadZone = SHIP_STEER_DEAD_ZONE) {
  const magnitude = Math.abs(clamp(value, -1, 1));
  if (magnitude <= deadZone) return 0;
  const normalized = (magnitude - deadZone) / Math.max(Number.EPSILON, 1 - deadZone);
  return Math.sign(value) * normalized * normalized;
}

/**
 * A small free-flight craft rendered in the same camera-relative frame as the
 * astronaut. Its physics consumes real frame seconds and never the accelerated
 * ephemeris clock used by moons and survey orbiters.
 */
export class SurfaceSpaceship {
  private readonly root = new THREE.Group();
  private readonly trailRoot = new THREE.Group();
  private readonly absolute = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly surfaceDirection = new THREE.Vector3(1, 0, 0);
  private readonly forward = new THREE.Vector3(0, 0, 1);
  private readonly right = new THREE.Vector3(1, 0, 0);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly scratch = new THREE.Vector3();
  private readonly orientation = new THREE.Matrix4();
  private readonly rotationStep = new THREE.Quaternion();
  private readonly rotationEuler = new THREE.Euler(0, 0, 0, "XYZ");
  private readonly engineLeft = new THREE.Vector3(-3.25, 0.05, -4.55);
  private readonly engineRight = new THREE.Vector3(3.25, 0.05, -4.55);
  private readonly leftTrailPositions = new Float32Array(SHIP_TRAIL_MAX_POINTS * 3);
  private readonly rightTrailPositions = new Float32Array(SHIP_TRAIL_MAX_POINTS * 3);
  private readonly trailColors = new Float32Array(SHIP_TRAIL_MAX_POINTS * 3);
  private readonly leftTrailGeometry = new THREE.BufferGeometry();
  private readonly rightTrailGeometry = new THREE.BufferGeometry();
  private readonly flames: THREE.Mesh[] = [];
  private trailPoints: TrailPoint[] = [];
  private trailEmitCountdownS = 0;
  private parked = true;
  private active = false;
  private thrustVisible = false;
  private model: THREE.Object3D | null = null;
  private disposed = false;

  constructor(
    scene: THREE.Scene,
    private readonly terrainSurface: (direction: Vec3) => TraverseSurfaceSample,
    private readonly prefetch: (direction: Vec3) => void,
    private readonly onAssetError: (message: string) => void = () => undefined,
  ) {
    this.root.name = "Surface traverse spacecraft";
    this.trailRoot.name = "Spacecraft ion trail";
    this.root.visible = false;
    this.trailRoot.visible = false;
    this.buildEngineEffects();
    this.buildTrails();
    scene.add(this.root, this.trailRoot);
    if (typeof window !== "undefined") void this.loadModel();
  }

  private async loadModel() {
    try {
      const gltf = await new GLTFLoader().loadAsync(
        `${SURFACE_SPACESHIP_MODEL_PATH}?v=quaternius-ultimate-space-kit`,
      );
      if (this.disposed) return;
      this.model = gltf.scene;
      this.model.name = "Quaternius Ultimate Space Kit spaceship";
      this.model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(this.model);
      const sourceLengthM = Math.max(0.001, bounds.max.z - bounds.min.z);
      this.model.scale.multiplyScalar(SHIP_MODEL_LENGTH_M / sourceLengthM);
      this.model.updateMatrixWorld(true);
      bounds.setFromObject(this.model);
      const center = bounds.getCenter(new THREE.Vector3());
      this.model.position.set(
        -center.x,
        -SHIP_GROUND_CLEARANCE_M - bounds.min.y,
        -center.z,
      );
      this.model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = true;
        object.receiveShadow = true;
        object.frustumCulled = false;
      });
      this.root.add(this.model);
    } catch (error) {
      console.error("Unable to load the Quaternius surface spaceship", error);
      this.onAssetError("The Ultimate Space Kit spaceship model could not be loaded.");
    }
  }

  private buildEngineEffects() {
    const engineMaterial = new THREE.MeshStandardMaterial({
      color: 0x54bce8,
      emissive: 0x1478aa,
      emissiveIntensity: 2.8,
      toneMapped: true,
    });
    for (const x of [this.engineLeft.x, this.engineRight.x]) {
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.31, 1.7, 14, 1, true), engineMaterial);
      flame.rotation.x = -Math.PI / 2;
      flame.position.set(x, 0.05, -5.35);
      flame.visible = false;
      this.flames.push(flame);
      this.root.add(flame);
    }
  }

  private buildTrails() {
    this.leftTrailGeometry.setAttribute("position", new THREE.BufferAttribute(this.leftTrailPositions, 3));
    this.rightTrailGeometry.setAttribute("position", new THREE.BufferAttribute(this.rightTrailPositions, 3));
    this.leftTrailGeometry.setAttribute("color", new THREE.BufferAttribute(this.trailColors, 3));
    this.rightTrailGeometry.setAttribute("color", new THREE.BufferAttribute(this.trailColors, 3));
    this.leftTrailGeometry.setDrawRange(0, 0);
    this.rightTrailGeometry.setDrawRange(0, 0);
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const left = new THREE.Line(this.leftTrailGeometry, material);
    const right = new THREE.Line(this.rightTrailGeometry, material.clone());
    left.frustumCulled = false;
    right.frustumCulled = false;
    left.renderOrder = 9_000;
    right.renderOrder = 9_000;
    const particlesMaterial = new THREE.PointsMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      size: 0.22,
      sizeAttenuation: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const leftParticles = new THREE.Points(this.leftTrailGeometry, particlesMaterial);
    const rightParticles = new THREE.Points(this.rightTrailGeometry, particlesMaterial.clone());
    leftParticles.frustumCulled = false;
    rightParticles.frustumCulled = false;
    leftParticles.renderOrder = 9_001;
    rightParticles.renderOrder = 9_001;
    this.trailRoot.add(left, right, leftParticles, rightParticles);
  }

  spawnNear(originDirection: THREE.Vector3, headingForward: THREE.Vector3, headingRight: THREE.Vector3) {
    this.surfaceDirection.copy(originDirection)
      .addScaledVector(headingForward, SHIP_SPAWN_FORWARD_M / MARS_REFERENCE_RADIUS_M)
      .addScaledVector(headingRight, SHIP_SPAWN_RIGHT_M / MARS_REFERENCE_RADIUS_M)
      .normalize();
    const surface = this.terrainSurface(this.surfaceDirection);
    this.absolute.copy(this.surfaceDirection).multiplyScalar(
      MARS_REFERENCE_RADIUS_M + surface.heightM + SHIP_GROUND_CLEARANCE_M,
    );
    this.up.copy(this.surfaceDirection);
    this.forward.copy(headingForward).addScaledVector(this.up, -headingForward.dot(this.up)).normalize();
    this.right.crossVectors(this.up, this.forward).normalize();
    this.orientation.makeBasis(this.right, this.up, this.forward);
    this.root.quaternion.setFromRotationMatrix(this.orientation);
    this.velocity.set(0, 0, 0);
    this.parked = true;
    this.active = true;
    this.thrustVisible = false;
    this.root.visible = true;
    this.trailRoot.visible = true;
    this.trailPoints = [];
    this.trailEmitCountdownS = 0;
    this.setFlamesVisible(false);
    this.prefetch(this.surfaceDirection);
  }

  deactivate() {
    this.active = false;
    this.parked = true;
    this.root.visible = false;
    this.trailRoot.visible = false;
    this.trailPoints = [];
    this.leftTrailGeometry.setDrawRange(0, 0);
    this.rightTrailGeometry.setDrawRange(0, 0);
    this.setFlamesVisible(false);
  }

  board() {
    this.parked = false;
    this.velocity.set(0, 0, 0);
  }

  updateParkedPosition() {
    if (!this.active || !this.parked) return;
    const surface = this.terrainSurface(this.surfaceDirection);
    this.absolute.copy(this.surfaceDirection).multiplyScalar(
      MARS_REFERENCE_RADIUS_M + surface.heightM + SHIP_GROUND_CLEARANCE_M,
    );
  }

  updateFlight(deltaSeconds: number, input: SpaceshipFlightInput) {
    if (!this.active || this.parked) return;
    const delta = clamp(deltaSeconds, 0, 0.05);
    const yaw = spaceshipSteerAmount(input.aimX) * 1.45;
    const pitch = -spaceshipSteerAmount(input.aimY) * 1.3;
    const automaticBank = -spaceshipSteerAmount(input.aimX) * 0.48;
    const roll = clamp(input.roll, -1, 1) * 1.55 + automaticBank;
    this.rotationEuler.set(pitch * delta, yaw * delta, roll * delta);
    this.rotationStep.setFromEuler(this.rotationEuler);
    this.root.quaternion.multiply(this.rotationStep).normalize();

    this.forward.set(0, 0, 1).applyQuaternion(this.root.quaternion).normalize();
    this.right.set(1, 0, 0).applyQuaternion(this.root.quaternion).normalize();
    this.up.set(0, 1, 0).applyQuaternion(this.root.quaternion).normalize();
    const thrust = clamp(input.throttle, -1, 1);
    const thrustAcceleration = input.boost ? SHIP_BOOST_THRUST_M_S2 : SHIP_THRUST_M_S2;
    this.velocity.addScaledVector(this.forward, thrust * thrustAcceleration * delta);
    this.velocity.addScaledVector(this.right, clamp(input.strafe, -1, 1) * SHIP_MANEUVER_THRUST_M_S2 * delta);
    this.velocity.addScaledVector(this.up, clamp(input.lift, -1, 1) * SHIP_MANEUVER_THRUST_M_S2 * delta);

    const radiusM = Math.max(MARS_REFERENCE_RADIUS_M, this.absolute.length());
    this.scratch.copy(this.absolute).normalize();
    const gravityMps2 = MARS_SURFACE_GRAVITY_M_S2 * (MARS_REFERENCE_RADIUS_M / radiusM) ** 2;
    this.velocity.addScaledVector(this.scratch, -gravityMps2 * delta);

    const altitudeM = radiusM - MARS_REFERENCE_RADIUS_M;
    const atmosphericDensity = Math.exp(-Math.max(0, altitudeM) / 11_100);
    this.velocity.multiplyScalar(Math.exp(-delta * (0.002 + atmosphericDensity * 0.038)));
    const speedMps = this.velocity.length();
    if (speedMps > SHIP_MAX_SPEED_M_S) this.velocity.multiplyScalar(SHIP_MAX_SPEED_M_S / speedMps);
    this.absolute.addScaledVector(this.velocity, delta);

    this.surfaceDirection.copy(this.absolute).normalize();
    const surface = this.terrainSurface(this.surfaceDirection);
    const minimumRadiusM = MARS_REFERENCE_RADIUS_M + surface.heightM + SHIP_GROUND_CLEARANCE_M;
    const nextRadiusM = this.absolute.length();
    if (nextRadiusM < minimumRadiusM) {
      this.absolute.copy(this.surfaceDirection).multiplyScalar(minimumRadiusM);
      const inwardSpeedMps = this.velocity.dot(this.surfaceDirection);
      if (inwardSpeedMps < 0) this.velocity.addScaledVector(this.surfaceDirection, -inwardSpeedMps);
    }
    if (this.absolute.length() - minimumRadiusM < 50_000) this.prefetch(this.surfaceDirection);

    this.thrustVisible = Math.abs(thrust) > 0.04;
    this.setFlamesVisible(this.thrustVisible);
    this.updateTrailLife(delta);
    if (this.thrustVisible) {
      this.trailEmitCountdownS -= delta;
      if (this.trailEmitCountdownS <= 0) {
        this.emitTrailPoint();
        this.trailEmitCountdownS = SHIP_TRAIL_POINT_INTERVAL_S;
      }
    } else {
      this.trailEmitCountdownS = 0;
    }
  }

  private emitTrailPoint() {
    const left = this.engineLeft.clone().applyQuaternion(this.root.quaternion).add(this.absolute);
    const right = this.engineRight.clone().applyQuaternion(this.root.quaternion).add(this.absolute);
    this.trailPoints.push({ left, right, lifeS: SHIP_TRAIL_LIFETIME_S });
    if (this.trailPoints.length > SHIP_TRAIL_MAX_POINTS) this.trailPoints.shift();
  }

  private updateTrailLife(deltaSeconds: number) {
    for (const point of this.trailPoints) point.lifeS -= deltaSeconds;
    while (this.trailPoints[0]?.lifeS <= 0) this.trailPoints.shift();
  }

  private setFlamesVisible(visible: boolean) {
    for (const flame of this.flames) flame.visible = visible;
  }

  syncVisual(cameraAbsolute: THREE.Vector3) {
    if (!this.active) return;
    this.root.position.copy(this.absolute).sub(cameraAbsolute);
    const pointCount = Math.min(this.trailPoints.length, SHIP_TRAIL_MAX_POINTS);
    for (let index = 0; index < pointCount; index += 1) {
      const point = this.trailPoints[this.trailPoints.length - pointCount + index];
      const offset = index * 3;
      this.leftTrailPositions[offset] = point.left.x - cameraAbsolute.x;
      this.leftTrailPositions[offset + 1] = point.left.y - cameraAbsolute.y;
      this.leftTrailPositions[offset + 2] = point.left.z - cameraAbsolute.z;
      this.rightTrailPositions[offset] = point.right.x - cameraAbsolute.x;
      this.rightTrailPositions[offset + 1] = point.right.y - cameraAbsolute.y;
      this.rightTrailPositions[offset + 2] = point.right.z - cameraAbsolute.z;
      const brightness = 0.08 + 0.92 * index / Math.max(1, pointCount - 1);
      this.trailColors[offset] = 0.34 * brightness;
      this.trailColors[offset + 1] = 0.72 * brightness;
      this.trailColors[offset + 2] = brightness;
    }
    (this.leftTrailGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.rightTrailGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.leftTrailGeometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    (this.rightTrailGeometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    this.leftTrailGeometry.setDrawRange(0, pointCount);
    this.rightTrailGeometry.setDrawRange(0, pointCount);
  }

  distanceTo(point: THREE.Vector3) {
    return this.absolute.distanceTo(point);
  }

  getAbsolute(target: THREE.Vector3) {
    return target.copy(this.absolute);
  }

  getForward(target: THREE.Vector3) {
    return target.set(0, 0, 1).applyQuaternion(this.root.quaternion).normalize();
  }

  getRight(target: THREE.Vector3) {
    return target.set(1, 0, 0).applyQuaternion(this.root.quaternion).normalize();
  }

  getUp(target: THREE.Vector3) {
    return target.set(0, 1, 0).applyQuaternion(this.root.quaternion).normalize();
  }

  getSpeedMps() {
    return this.velocity.length();
  }

  dispose() {
    this.disposed = true;
    this.deactivate();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      objectMaterials.forEach((material) => materials.add(material));
    });
    this.trailRoot.traverse((object) => {
      if (!(object instanceof THREE.Line) && !(object instanceof THREE.Points)) return;
      geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      objectMaterials.forEach((material) => materials.add(material));
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.root.removeFromParent();
    this.trailRoot.removeFromParent();
  }
}
