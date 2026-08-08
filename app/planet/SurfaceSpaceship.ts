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
const SHIP_TRAIL_MAX_POINTS = 420;
const SHIP_STEER_DEAD_ZONE = 0.055;
const SHIP_ROTATION_RESPONSE_S = 16;
const SHIP_TRANSLATION_RESPONSE_S = 16;
const SHIP_AIM_RESPONSE_S = 9;
const SHIP_AIM_MAX_RATE_RAD_S = 2.8;
const SHIP_MODEL_LENGTH_M = 9.2;
const SHIP_ENGINE_NOZZLE_Z = -4.55;
const SHIP_ENGINE_FLAME_LENGTH_M = 1.9;
const SHIP_BOOST_FLAME_LENGTH_M = 5.8;

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
  phase: number;
};

type PlumeMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

type EnginePlume = {
  outer: PlumeMesh;
  core: PlumeMesh;
  boostOuter: PlumeMesh;
  boostCore: PlumeMesh;
  shockDiamonds: PlumeMesh[];
};

export type SpaceshipTrailStyle = {
  color: readonly [number, number, number];
  lifetimeS: number;
  pointIntervalS: number;
};

const NORMAL_TRAIL_STYLE: SpaceshipTrailStyle = {
  color: [0.08, 0.52, 1],
  lifetimeS: 4.8,
  pointIntervalS: 0.03,
};

const BOOST_TRAIL_STYLE: SpaceshipTrailStyle = {
  color: [1, 0.22, 0.025],
  lifetimeS: 8,
  pointIntervalS: 0.014,
};

export function spaceshipTrailStyle(boosted: boolean): SpaceshipTrailStyle {
  return boosted ? BOOST_TRAIL_STYLE : NORMAL_TRAIL_STYLE;
}

export function spaceshipPlumeAnimation(
  timeSeconds: number,
  thrust: number,
  boosted: boolean,
  engineIndex = 0,
) {
  const power = clamp(Math.abs(thrust), 0, 1);
  const phase = timeSeconds * (boosted ? 34 : 22) + engineIndex * 1.73;
  const fastFlutter = 0.5 + 0.5 * Math.sin(phase);
  const turbulence = 0.5 + 0.5 * Math.sin(phase * 0.43 + Math.sin(phase * 0.19));
  return {
    outerLengthScale: (0.72 + power * 0.72) * (0.9 + fastFlutter * 0.12),
    outerRadiusScale: (0.76 + power * 0.3) * (0.94 + turbulence * 0.08),
    outerOpacity: 0.42 + power * 0.34,
    coreLengthScale: (0.62 + power * 0.58) * (0.91 + turbulence * 0.13),
    coreRadiusScale: (0.7 + power * 0.18) * (0.96 + fastFlutter * 0.06),
    coreOpacity: 0.68 + power * 0.27,
    boostLengthScale: boosted
      ? (0.94 + power * 0.5) * (0.86 + turbulence * 0.2)
      : 0,
    boostRadiusScale: boosted
      ? (0.9 + power * 0.38) * (0.9 + fastFlutter * 0.13)
      : 0,
    boostOpacity: boosted ? 0.58 + power * 0.32 : 0,
    shockPulse: 0.76 + 0.28 * Math.sin(phase * 0.74 + 0.6),
  };
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
  private readonly enginePlumes: EnginePlume[] = [];
  private readonly engineLight = new THREE.PointLight(0x78d8ff, 0, 18, 2);
  private readonly trailAcross = new THREE.Vector3();
  private readonly trailNormal = new THREE.Vector3();
  private readonly trailLeftVisual = new THREE.Vector3();
  private readonly trailRightVisual = new THREE.Vector3();
  private trailPoints: TrailPoint[] = [];
  private trailEmitCountdownS = 0;
  private effectTimeSeconds = 0;
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
    const material = (color: number, opacity: number) => new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const normalOuterGeometry = new THREE.ConeGeometry(0.39, SHIP_ENGINE_FLAME_LENGTH_M, 18, 2, true);
    const normalCoreGeometry = new THREE.ConeGeometry(0.19, SHIP_ENGINE_FLAME_LENGTH_M * 0.74, 16, 1, true);
    const boostOuterGeometry = new THREE.ConeGeometry(0.43, SHIP_BOOST_FLAME_LENGTH_M, 20, 3, true);
    const boostCoreGeometry = new THREE.ConeGeometry(0.18, SHIP_BOOST_FLAME_LENGTH_M * 0.62, 18, 2, true);
    const shockGeometry = new THREE.OctahedronGeometry(0.2, 0);

    [this.engineLeft.x, this.engineRight.x].forEach((x, engineIndex) => {
      const outer = new THREE.Mesh(normalOuterGeometry, material(0x2b9fff, 0.68));
      outer.name = "Spacecraft animated engine plume";
      outer.rotation.x = -Math.PI / 2;

      const core = new THREE.Mesh(normalCoreGeometry, material(0xd9fbff, 0.92));
      core.name = "Spacecraft engine hot core";
      core.rotation.x = -Math.PI / 2;

      const boostOuter = new THREE.Mesh(boostOuterGeometry, material(0xff541c, 0.82));
      boostOuter.name = "Spacecraft boost plume";
      boostOuter.rotation.x = -Math.PI / 2;

      const boostCore = new THREE.Mesh(boostCoreGeometry, material(0xfff2b0, 0.94));
      boostCore.name = "Spacecraft boost hot core";
      boostCore.rotation.x = -Math.PI / 2;

      const shockDiamonds = Array.from({ length: 3 }, (_, shockIndex) => {
        const shock = new THREE.Mesh(
          shockGeometry,
          material(shockIndex % 2 === 0 ? 0xfff5d6 : 0xff8b32, 0.84),
        );
        shock.name = "Spacecraft boost shock diamond";
        shock.position.set(x, 0.05, SHIP_ENGINE_NOZZLE_Z - 2.15 - shockIndex * 1.28);
        shock.visible = false;
        shock.renderOrder = 8_998 + shockIndex;
        this.root.add(shock);
        return shock;
      });

      for (const plume of [outer, core, boostOuter, boostCore]) {
        plume.position.set(x, 0.05, SHIP_ENGINE_NOZZLE_Z);
        plume.visible = false;
        plume.renderOrder = 9_000 + engineIndex;
        this.root.add(plume);
      }
      this.enginePlumes.push({ outer, core, boostOuter, boostCore, shockDiamonds });
    });

    this.engineLight.name = "Spacecraft exhaust illumination";
    this.engineLight.position.set(0, 0.08, SHIP_ENGINE_NOZZLE_Z - 0.25);
    this.root.add(this.engineLight);
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
    const haloMaterial = new THREE.PointsMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.22,
      size: 0.58,
      sizeAttenuation: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const coreMaterial = new THREE.PointsMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      size: 0.15,
      sizeAttenuation: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const leftHalo = new THREE.Points(this.leftTrailGeometry, haloMaterial);
    const rightHalo = new THREE.Points(this.rightTrailGeometry, haloMaterial.clone());
    const leftCore = new THREE.Points(this.leftTrailGeometry, coreMaterial);
    const rightCore = new THREE.Points(this.rightTrailGeometry, coreMaterial.clone());
    for (const particles of [leftHalo, rightHalo, leftCore, rightCore]) {
      particles.frustumCulled = false;
      particles.renderOrder = particles === leftHalo || particles === rightHalo ? 9_001 : 9_002;
    }
    this.trailRoot.add(left, right, leftHalo, rightHalo, leftCore, rightCore);
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
    this.effectTimeSeconds = 0;
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
    this.updateEngineEffect(delta, this.thrustVisible ? Math.abs(thrust) : 0, boostVisible);
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
      phase: this.effectTimeSeconds * 2.3 + this.trailPoints.length * 0.61,
    });
    if (this.trailPoints.length > SHIP_TRAIL_MAX_POINTS) this.trailPoints.shift();
  }

  private updateTrailLife(deltaSeconds: number) {
    for (const point of this.trailPoints) point.lifeS -= deltaSeconds;
    while (this.trailPoints[0]?.lifeS <= 0) this.trailPoints.shift();
  }

  private setEngineEffect(visible: boolean, boosted: boolean) {
    for (const plume of this.enginePlumes) {
      plume.outer.visible = visible;
      plume.core.visible = visible;
      plume.boostOuter.visible = boosted;
      plume.boostCore.visible = boosted;
      for (const shock of plume.shockDiamonds) shock.visible = boosted;
    }
    if (!visible) this.engineLight.intensity = 0;
  }

  private updateEngineEffect(deltaSeconds: number, thrust: number, boosted: boolean) {
    this.effectTimeSeconds += deltaSeconds;
    const visible = thrust > 0.04;
    this.setEngineEffect(visible, visible && boosted);
    if (!visible) return;

    this.enginePlumes.forEach((plume, engineIndex) => {
      const frame = spaceshipPlumeAnimation(this.effectTimeSeconds, thrust, boosted, engineIndex);
      plume.outer.scale.set(frame.outerRadiusScale, frame.outerLengthScale, frame.outerRadiusScale);
      plume.outer.position.z = SHIP_ENGINE_NOZZLE_Z
        - SHIP_ENGINE_FLAME_LENGTH_M * frame.outerLengthScale * 0.5;
      plume.outer.material.opacity = frame.outerOpacity;

      plume.core.scale.set(frame.coreRadiusScale, frame.coreLengthScale, frame.coreRadiusScale);
      plume.core.position.z = SHIP_ENGINE_NOZZLE_Z
        - SHIP_ENGINE_FLAME_LENGTH_M * 0.74 * frame.coreLengthScale * 0.5;
      plume.core.material.opacity = frame.coreOpacity;

      if (boosted) {
        plume.boostOuter.scale.set(frame.boostRadiusScale, frame.boostLengthScale, frame.boostRadiusScale);
        plume.boostOuter.position.z = SHIP_ENGINE_NOZZLE_Z
          - SHIP_BOOST_FLAME_LENGTH_M * frame.boostLengthScale * 0.5;
        plume.boostOuter.material.opacity = frame.boostOpacity;

        plume.boostCore.scale.set(
          frame.boostRadiusScale * 0.72,
          frame.boostLengthScale * 0.78,
          frame.boostRadiusScale * 0.72,
        );
        plume.boostCore.position.z = SHIP_ENGINE_NOZZLE_Z
          - SHIP_BOOST_FLAME_LENGTH_M * 0.62 * frame.boostLengthScale * 0.78 * 0.5;
        plume.boostCore.material.opacity = Math.min(1, frame.boostOpacity + 0.12);

        plume.shockDiamonds.forEach((shock, shockIndex) => {
          const alternatingPulse = frame.shockPulse * (shockIndex % 2 === 0 ? 1 : 0.82);
          shock.position.z = SHIP_ENGINE_NOZZLE_Z
            - (2.05 + shockIndex * 1.28) * frame.boostLengthScale;
          shock.scale.set(
            frame.boostRadiusScale * alternatingPulse,
            frame.boostRadiusScale * alternatingPulse,
            (1.25 + shockIndex * 0.22) * alternatingPulse,
          );
          shock.material.opacity = frame.boostOpacity * (0.92 - shockIndex * 0.16);
        });
      }
    });

    this.engineLight.color.setHex(boosted ? 0xff7a30 : 0x70d9ff);
    this.engineLight.intensity = (boosted ? 46 : 15) * clamp(thrust, 0, 1);
    this.engineLight.distance = boosted ? 26 : 16;
  }

  syncVisual(cameraAbsolute: THREE.Vector3) {
    if (!this.active) return;
    this.root.position.copy(this.absolute).sub(cameraAbsolute);
    const pointCount = Math.min(this.trailPoints.length, SHIP_TRAIL_MAX_POINTS);
    for (let index = 0; index < pointCount; index += 1) {
      const point = this.trailPoints[this.trailPoints.length - pointCount + index];
      const offset = index * 3;
      const lifeFraction = clamp(point.lifeS / point.maxLifeS, 0, 1);
      const age = 1 - lifeFraction;
      this.trailAcross.subVectors(point.right, point.left).normalize();
      this.trailNormal.copy(point.left).add(point.right).multiplyScalar(0.5).normalize();
      const ripple = Math.sin(this.effectTimeSeconds * 8 + point.phase + age * 17)
        * Math.pow(age, 1.25)
        * (point.boosted ? 0.3 : 0.11);
      const spread = Math.pow(age, 1.4) * (point.boosted ? 0.28 : 0.1);
      this.trailLeftVisual.copy(point.left)
        .addScaledVector(this.trailNormal, ripple)
        .addScaledVector(this.trailAcross, -spread);
      this.trailRightVisual.copy(point.right)
        .addScaledVector(this.trailNormal, -ripple)
        .addScaledVector(this.trailAcross, spread);

      this.leftTrailPositions[offset] = this.trailLeftVisual.x - cameraAbsolute.x;
      this.leftTrailPositions[offset + 1] = this.trailLeftVisual.y - cameraAbsolute.y;
      this.leftTrailPositions[offset + 2] = this.trailLeftVisual.z - cameraAbsolute.z;
      this.rightTrailPositions[offset] = this.trailRightVisual.x - cameraAbsolute.x;
      this.rightTrailPositions[offset + 1] = this.trailRightVisual.y - cameraAbsolute.y;
      this.rightTrailPositions[offset + 2] = this.trailRightVisual.z - cameraAbsolute.z;

      const headBrightness = 0.08 + 0.92 * index / Math.max(1, pointCount - 1);
      const animatedFlicker = 0.84 + 0.16 * Math.sin(this.effectTimeSeconds * 19 + point.phase);
      const brightness = headBrightness * Math.sqrt(lifeFraction) * animatedFlicker;
      const hotMix = clamp((lifeFraction - 0.68) / 0.32, 0, 1);
      const tailColor = spaceshipTrailStyle(point.boosted).color;
      const hotColor: readonly [number, number, number] = point.boosted
        ? [1, 0.9, 0.56]
        : [0.72, 0.96, 1];
      this.trailColors[offset] = (tailColor[0] + (hotColor[0] - tailColor[0]) * hotMix) * brightness;
      this.trailColors[offset + 1] = (tailColor[1] + (hotColor[1] - tailColor[1]) * hotMix) * brightness;
      this.trailColors[offset + 2] = (tailColor[2] + (hotColor[2] - tailColor[2]) * hotMix) * brightness;
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
