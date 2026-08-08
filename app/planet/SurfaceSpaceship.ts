import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MARS_REFERENCE_RADIUS_M } from "./constants";
import { clamp } from "./math";
import type { TraverseSurfaceSample } from "./SurfaceTraverseController";
import type { Vec3 } from "./types";

const SHIP_GROUND_CLEARANCE_M = 1.15;
const SHIP_SPAWN_FORWARD_M = 18;
const SHIP_SPAWN_RIGHT_M = 2.5;
const SHIP_THRUST_M_S2 = 76;
const SHIP_BOOST_THRUST_M_S2 = 260;
const SHIP_MANEUVER_THRUST_M_S2 = 52;
const SHIP_VERTICAL_THRUST_M_S2 = 86;
const SHIP_BRAKE_RATE_S = 5.8;
const SHIP_YAW_RATE_RAD_S = 1.85;
const SHIP_PITCH_RATE_RAD_S = 1.55;
const SHIP_ROLL_RATE_RAD_S = 2.25;
const SHIP_SHARP_TURN_MULTIPLIER = 1.85;
const SHIP_MAX_SPEED_M_S = 12_000;
const SHIP_TRAIL_MAX_POINTS = 240;
const SHIP_STEER_DEAD_ZONE = 0.055;
const SHIP_ROTATION_RESPONSE_S = 16;
const SHIP_TRANSLATION_RESPONSE_S = 16;
const SHIP_AIM_RESPONSE_S = 9;
const SHIP_AIM_MAX_RATE_RAD_S = 2.8;
const SHIP_MODEL_LENGTH_M = 9.2;

export const SHIP_BOARD_DISTANCE_M = 5.5;
export const SURFACE_SPACESHIP_MODEL_PATH = "/models/surface-spaceship.glb";

export type SpaceshipFlightInput = {
  throttle: number;
  strafe: number;
  lift: number;
  yaw: number;
  pitch: number;
  roll: number;
  boost: boolean;
  brake: boolean;
  aimX: number;
  aimY: number;
  aimDirection?: Vec3;
};

type TrailPoint = {
  left: THREE.Vector3;
  right: THREE.Vector3;
  lifeS: number;
  maxLifeS: number;
  boosted: boolean;
};

export type SpaceshipTrailStyle = {
  color: readonly [number, number, number];
  lifetimeS: number;
  pointIntervalS: number;
};

const NORMAL_TRAIL_STYLE: SpaceshipTrailStyle = {
  color: [0.22, 0.68, 1],
  lifetimeS: 4.2,
  pointIntervalS: 0.035,
};

const BOOST_TRAIL_STYLE: SpaceshipTrailStyle = {
  color: [1, 0.3, 0.055],
  lifetimeS: 7.4,
  pointIntervalS: 0.016,
};

export function spaceshipTrailStyle(boosted: boolean): SpaceshipTrailStyle {
  return boosted ? BOOST_TRAIL_STYLE : NORMAL_TRAIL_STYLE;
}

export function spaceshipSteerAmount(value: number, deadZone = SHIP_STEER_DEAD_ZONE) {
  const magnitude = Math.abs(clamp(value, -1, 1));
  if (magnitude <= deadZone) return 0;
  const normalized = (magnitude - deadZone) / Math.max(Number.EPSILON, 1 - deadZone);
  // Preserve fine control around the centre without the old squared curve's
  // large unresponsive patch. The result still eases in instead of stepping.
  return Math.sign(value) * normalized * (0.45 + 0.55 * normalized);
}

export function spaceshipDirectionalSteer(pointerAim: number, keyboardInput: number) {
  const directInput = clamp(keyboardInput, -1, 1);
  return Math.abs(directInput) > 0.001 ? directInput : spaceshipSteerAmount(pointerAim);
}

export function spaceshipDampedInput(current: number, target: number, responsePerSecond: number, deltaSeconds: number) {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return 0;
  const alpha = 1 - Math.exp(-Math.max(0, responsePerSecond) * Math.max(0, deltaSeconds));
  return current + (target - current) * alpha;
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
  private readonly radialUp = new THREE.Vector3(1, 0, 0);
  private readonly orientation = new THREE.Matrix4();
  private readonly rotationStep = new THREE.Quaternion();
  private readonly previousRotation = new THREE.Quaternion();
  private readonly velocityRotation = new THREE.Quaternion();
  private readonly rotationEuler = new THREE.Euler(0, 0, 0, "XYZ");
  private readonly aimForward = new THREE.Vector3();
  private readonly aimAxis = new THREE.Vector3();
  private readonly engineLeft = new THREE.Vector3(-3.25, 0.05, -4.55);
  private readonly engineRight = new THREE.Vector3(3.25, 0.05, -4.55);
  private readonly leftTrailPositions = new Float32Array(SHIP_TRAIL_MAX_POINTS * 3);
  private readonly rightTrailPositions = new Float32Array(SHIP_TRAIL_MAX_POINTS * 3);
  private readonly trailColors = new Float32Array(SHIP_TRAIL_MAX_POINTS * 3);
  private readonly leftTrailGeometry = new THREE.BufferGeometry();
  private readonly rightTrailGeometry = new THREE.BufferGeometry();
  private readonly flames: THREE.Mesh[] = [];
  private readonly boostFlames: THREE.Mesh[] = [];
  private trailPoints: TrailPoint[] = [];
  private trailEmitCountdownS = 0;
  private parked = true;
  private groundAnchored = true;
  private stationKeeping = true;
  private active = false;
  private thrustVisible = false;
  private smoothedThrottle = 0;
  private smoothedStrafe = 0;
  private smoothedLift = 0;
  private smoothedYaw = 0;
  private smoothedPitch = 0;
  private smoothedRoll = 0;
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
    const boostMaterial = new THREE.MeshBasicMaterial({
      color: 0xff7a24,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    for (const x of [this.engineLeft.x, this.engineRight.x]) {
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.31, 1.7, 14, 1, true), engineMaterial);
      flame.rotation.x = -Math.PI / 2;
      flame.position.set(x, 0.05, -5.35);
      flame.visible = false;
      this.flames.push(flame);
      this.root.add(flame);

      const boostFlame = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 4.4, 14, 1, true),
        boostMaterial,
      );
      boostFlame.name = "Spacecraft boost plume";
      boostFlame.rotation.x = -Math.PI / 2;
      boostFlame.position.set(x, 0.05, -6.7);
      boostFlame.visible = false;
      this.boostFlames.push(boostFlame);
      this.root.add(boostFlame);
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
    this.groundAnchored = true;
    this.stationKeeping = true;
    this.active = true;
    this.thrustVisible = false;
    this.resetInputSmoothing();
    this.root.visible = true;
    this.trailRoot.visible = true;
    this.trailPoints = [];
    this.trailEmitCountdownS = 0;
    this.setEngineEffect(false, false);
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
    this.setEngineEffect(false, false);
  }

  board() {
    this.parked = false;
    this.groundAnchored = false;
    this.stationKeeping = true;
    this.velocity.set(0, 0, 0);
    this.resetInputSmoothing();
  }

  stopAndPark() {
    if (!this.active) return;
    this.velocity.set(0, 0, 0);
    this.parked = true;
    this.groundAnchored = false;
    this.stationKeeping = true;
    this.thrustVisible = false;
    this.resetInputSmoothing();
    this.trailPoints = [];
    this.trailEmitCountdownS = 0;
    this.leftTrailGeometry.setDrawRange(0, 0);
    this.rightTrailGeometry.setDrawRange(0, 0);
    this.setEngineEffect(false, false);
  }

  updateParkedPosition() {
    if (!this.active || !this.parked || !this.groundAnchored) return;
    const surface = this.terrainSurface(this.surfaceDirection);
    this.absolute.copy(this.surfaceDirection).multiplyScalar(
      MARS_REFERENCE_RADIUS_M + surface.heightM + SHIP_GROUND_CLEARANCE_M,
    );
  }

  updateFlight(deltaSeconds: number, input: SpaceshipFlightInput) {
    if (!this.active || this.parked) return;
    const delta = clamp(deltaSeconds, 0, 0.05);
    const turnMultiplier = input.boost ? SHIP_SHARP_TURN_MULTIPLIER : 1;
    // A pressed direction is authoritative on its axis. A stale pointer at the
    // opposite screen edge must never cancel or reverse a keyboard command.
    const keyboardYaw = clamp(input.yaw, -1, 1);
    const keyboardPitch = clamp(input.pitch, -1, 1);
    const hasCameraAim = input.aimDirection !== undefined &&
      Number.isFinite(input.aimDirection.x) &&
      Number.isFinite(input.aimDirection.y) &&
      Number.isFinite(input.aimDirection.z) &&
      Math.hypot(input.aimDirection.x, input.aimDirection.y, input.aimDirection.z) > 1e-7;
    const yawInput = hasCameraAim ? keyboardYaw : spaceshipDirectionalSteer(input.aimX, keyboardYaw);
    const pitchInput = hasCameraAim ? keyboardPitch : spaceshipDirectionalSteer(input.aimY, keyboardPitch);
    this.smoothedYaw = spaceshipDampedInput(this.smoothedYaw, yawInput, SHIP_ROTATION_RESPONSE_S, delta);
    this.smoothedPitch = spaceshipDampedInput(this.smoothedPitch, pitchInput, SHIP_ROTATION_RESPONSE_S, delta);
    this.smoothedRoll = spaceshipDampedInput(
      this.smoothedRoll,
      clamp(input.roll, -1, 1),
      SHIP_ROTATION_RESPONSE_S,
      delta,
    );
    this.previousRotation.copy(this.root.quaternion);
    const manualSteering = Math.abs(keyboardYaw) > 0.001 ||
      Math.abs(keyboardPitch) > 0.001 ||
      Math.abs(this.smoothedYaw) > 0.02 ||
      Math.abs(this.smoothedPitch) > 0.02;
    if (hasCameraAim && input.aimDirection && !manualSteering) {
      this.forward.set(0, 0, 1).applyQuaternion(this.root.quaternion).normalize();
      this.aimForward.set(
        input.aimDirection.x,
        input.aimDirection.y,
        input.aimDirection.z,
      ).normalize();
      const aimDot = clamp(this.forward.dot(this.aimForward), -1, 1);
      const aimAngleRad = Math.acos(aimDot);
      if (aimAngleRad > 1e-7) {
        this.aimAxis.crossVectors(this.forward, this.aimForward);
        if (this.aimAxis.lengthSq() <= 1e-10) {
          this.aimAxis.set(0, 1, 0).applyQuaternion(this.root.quaternion);
        } else {
          this.aimAxis.normalize();
        }
        const easedStepRad = aimAngleRad * (1 - Math.exp(-SHIP_AIM_RESPONSE_S * delta));
        const maxStepRad = SHIP_AIM_MAX_RATE_RAD_S * turnMultiplier * delta;
        this.rotationStep.setFromAxisAngle(
          this.aimAxis,
          Math.min(aimAngleRad, easedStepRad, maxStepRad),
        );
        this.root.quaternion.premultiply(this.rotationStep).normalize();
      }
    }

    // Keyboard steering remains craft-relative and temporarily overrides the
    // camera aim. Releasing it lets the nose ease back onto the camera's
    // independent centreline instead of feeding the ship's own turn back into
    // the target direction.
    this.rotationEuler.set(
      -this.smoothedPitch * SHIP_PITCH_RATE_RAD_S * turnMultiplier * delta,
      -this.smoothedYaw * SHIP_YAW_RATE_RAD_S * turnMultiplier * delta,
      this.smoothedRoll * SHIP_ROLL_RATE_RAD_S * turnMultiplier * delta,
    );
    this.rotationStep.setFromEuler(this.rotationEuler);
    this.root.quaternion.multiply(this.rotationStep).normalize();

    // This is an intentionally assisted, game-feel flight model: the craft's
    // existing momentum follows the same world-space rotation as its hull.
    // Without it, yaw only rotates the mesh while inertia keeps carrying the
    // ship along its old line, which feels like steering a detached camera.
    this.previousRotation.invert();
    this.velocityRotation.copy(this.root.quaternion).multiply(this.previousRotation).normalize();
    this.velocity.applyQuaternion(this.velocityRotation);

    this.forward.set(0, 0, 1).applyQuaternion(this.root.quaternion).normalize();
    this.right.set(1, 0, 0).applyQuaternion(this.root.quaternion).normalize();
    this.up.set(0, 1, 0).applyQuaternion(this.root.quaternion).normalize();
    if (input.brake) {
      this.smoothedThrottle = 0;
      this.smoothedStrafe = 0;
      this.smoothedLift = 0;
    } else {
      this.smoothedThrottle = spaceshipDampedInput(
        this.smoothedThrottle,
        clamp(input.throttle, -1, 1),
        SHIP_TRANSLATION_RESPONSE_S,
        delta,
      );
      this.smoothedStrafe = spaceshipDampedInput(
        this.smoothedStrafe,
        clamp(input.strafe, -1, 1),
        SHIP_TRANSLATION_RESPONSE_S,
        delta,
      );
      this.smoothedLift = spaceshipDampedInput(
        this.smoothedLift,
        clamp(input.lift, -1, 1),
        SHIP_TRANSLATION_RESPONSE_S,
        delta,
      );
    }
    const thrust = this.smoothedThrottle;
    const strafe = this.smoothedStrafe;
    const lift = this.smoothedLift;
    const translationInput = Math.max(Math.abs(thrust), Math.abs(strafe), Math.abs(lift));
    if (input.brake) this.stationKeeping = true;
    else if (translationInput > 0.02) this.stationKeeping = false;

    const thrustAcceleration = input.boost ? SHIP_BOOST_THRUST_M_S2 : SHIP_THRUST_M_S2;
    this.radialUp.copy(this.absolute).normalize();
    if (!this.stationKeeping) {
      this.velocity.addScaledVector(this.forward, thrust * thrustAcceleration * delta);
      this.velocity.addScaledVector(this.right, strafe * SHIP_MANEUVER_THRUST_M_S2 * delta);
      this.velocity.addScaledVector(this.radialUp, lift * SHIP_VERTICAL_THRUST_M_S2 * delta);
    }

    const radiusM = Math.max(MARS_REFERENCE_RADIUS_M, this.absolute.length());
    // The assisted spacecraft flight computer cancels local gravity. This
    // keeps a nose-up coast climbing along the pointed flight vector instead
    // of letting gravity detach the trajectory from the hull and pull it down.

    const altitudeM = radiusM - MARS_REFERENCE_RADIUS_M;
    const atmosphericDensity = Math.exp(-Math.max(0, altitudeM) / 11_100);
    const brakeRate = this.stationKeeping ? SHIP_BRAKE_RATE_S : 0;
    this.velocity.multiplyScalar(Math.exp(-delta * (0.002 + atmosphericDensity * 0.038 + brakeRate)));
    if (this.stationKeeping && this.velocity.lengthSq() < 0.09) this.velocity.set(0, 0, 0);
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

    this.thrustVisible = !this.stationKeeping && Math.abs(thrust) > 0.04;
    const boostVisible = this.thrustVisible && input.boost && thrust > 0;
    this.setEngineEffect(this.thrustVisible, boostVisible);
    this.updateTrailLife(delta);
    if (this.thrustVisible) {
      const trailStyle = spaceshipTrailStyle(boostVisible);
      this.trailEmitCountdownS -= delta;
      if (this.trailEmitCountdownS <= 0) {
        this.emitTrailPoint(boostVisible);
        this.trailEmitCountdownS = trailStyle.pointIntervalS;
      }
    } else {
      this.trailEmitCountdownS = 0;
    }
  }

  private resetInputSmoothing() {
    this.smoothedThrottle = 0;
    this.smoothedStrafe = 0;
    this.smoothedLift = 0;
    this.smoothedYaw = 0;
    this.smoothedPitch = 0;
    this.smoothedRoll = 0;
  }

  private emitTrailPoint(boosted: boolean) {
    const left = this.engineLeft.clone().applyQuaternion(this.root.quaternion).add(this.absolute);
    const right = this.engineRight.clone().applyQuaternion(this.root.quaternion).add(this.absolute);
    const style = spaceshipTrailStyle(boosted);
    this.trailPoints.push({
      left,
      right,
      lifeS: style.lifetimeS,
      maxLifeS: style.lifetimeS,
      boosted,
    });
    if (this.trailPoints.length > SHIP_TRAIL_MAX_POINTS) this.trailPoints.shift();
  }

  private updateTrailLife(deltaSeconds: number) {
    for (const point of this.trailPoints) point.lifeS -= deltaSeconds;
    while (this.trailPoints[0]?.lifeS <= 0) this.trailPoints.shift();
  }

  private setEngineEffect(visible: boolean, boosted: boolean) {
    for (const flame of this.flames) {
      flame.visible = visible;
      flame.scale.set(boosted ? 1.28 : 1, boosted ? 1.72 : 1, boosted ? 1.28 : 1);
    }
    for (const boostFlame of this.boostFlames) boostFlame.visible = boosted;
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
      const ageFade = Math.sqrt(clamp(point.lifeS / point.maxLifeS, 0, 1));
      const brightness = (0.08 + 0.92 * index / Math.max(1, pointCount - 1)) * ageFade;
      const color = spaceshipTrailStyle(point.boosted).color;
      this.trailColors[offset] = color[0] * brightness;
      this.trailColors[offset + 1] = color[1] * brightness;
      this.trailColors[offset + 2] = color[2] * brightness;
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

  getVelocity(target: THREE.Vector3) {
    return target.copy(this.velocity);
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
