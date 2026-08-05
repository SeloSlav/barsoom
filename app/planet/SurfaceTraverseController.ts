import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  MARS_ATMOSPHERE_TOP_M,
  MARS_REFERENCE_RADIUS_M,
  MARS_SURFACE_GRAVITY_M_S2,
  MARS_TRAVERSE_JUMP_SPEED_M_S,
} from "./constants";
import { clamp, localEnuBasis } from "./math";
import type { PlanetControlState } from "./PlanetControls";
import type { Vec3 } from "./types";
import type { TraverseAudioEvent } from "../audio/BarsoomAudio";

const WALK_SPEED_M_S = 4.2;
const RUN_SPEED_M_S = 7.2;
const PLAYER_HEIGHT_M = 1.82;
const CAMERA_DEFAULT_DISTANCE_M = 7;
const CAMERA_FIRST_PERSON_DISTANCE_M = 0;
const CAMERA_FIRST_PERSON_ENTER_DISTANCE_M = 0.85;
const CAMERA_FIRST_PERSON_EXIT_DISTANCE_M = 2.2;
const CAMERA_MAX_DISTANCE_M = 39;
const CAMERA_TARGET_HEIGHT_M = 1.38;
const CAMERA_FIRST_PERSON_HEIGHT_M = 1.68;
const CAMERA_COLLISION_CLEARANCE_M = 0.35;
const CAMERA_COLLISION_SAMPLES = 12;
const CAMERA_COLLISION_RECOVERY_RATE = 1.5;
const CAMERA_INITIAL_LOOK_PITCH_RAD = THREE.MathUtils.degToRad(-14);
const CAMERA_MIN_PITCH_RAD = THREE.MathUtils.degToRad(-85);
const CAMERA_MAX_PITCH_RAD = THREE.MathUtils.degToRad(85);
const CAMERA_HEIGHT_SMOOTH_TIME_S = 0.34;
const CAMERA_MAX_HEIGHT_SPEED_M_S = 8;
const CAMERA_TERRAIN_REBASE_THRESHOLD_M = 12;
const CAMERA_ENTRY_WHEEL_LOCK_S = 0.45;
const SURFACE_NORMAL_FOLLOW_RATE = 8;
const ENTRY_READY_MIN_LOD = 14;
const ENTRY_READY_STABLE_S = 0.32;
const ENTRY_READY_MAX_WAIT_S = 4.5;
const BOOT_SOLE_CLEARANCE_M = 0.025;
export const MARS_JUMP_ANTICIPATION_DURATION_S = 0.22;
const JUMP_LAUNCH_POSE_RELEASE_S = 0.3;
const JUMP_LANDING_POSE_DURATION_S = 0.28;

type AnimationName = "idle" | "idle_neutral" | "walk" | "run" | "jump" | "jump_idle" | "jump_land";

type JumpPoseWeights = {
  squat: number;
  descent: number;
};

export type TraverseSurfaceSample = {
  heightM: number;
  normal: Vec3;
  lod?: number;
};

export function randomMarsSurfaceDirection(random: () => number = Math.random): Vec3 {
  const y = clamp(random() * 2 - 1, -1, 1);
  const longitude = random() * Math.PI * 2;
  const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
  if (horizontal === 0) return { x: 0, y, z: 0 };
  return {
    x: horizontal * Math.cos(longitude),
    y,
    z: horizontal * Math.sin(longitude),
  };
}

export function randomMarsDaylightDirection(
  sunDirection: Vec3,
  random: () => number = Math.random,
  minimumSunDot = 0.28,
): Vec3 {
  const sun = normalizeMarsSurfaceDirection(sunDirection);
  const minimumDot = clamp(minimumSunDot, -1, 1);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const candidate = randomMarsSurfaceDirection(random);
    if (candidate.x * sun.x + candidate.y * sun.y + candidate.z * sun.z >= minimumDot) return candidate;
  }
  return sun;
}

export function normalizeMarsSurfaceDirection(direction: Vec3): Vec3 {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    throw new RangeError("Surface target direction must be a finite, non-zero vector.");
  }
  return {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
}

export function marsJumpApexHeight(launchSpeedMps = MARS_TRAVERSE_JUMP_SPEED_M_S) {
  return (launchSpeedMps * launchSpeedMps) / (2 * MARS_SURFACE_GRAVITY_M_S2);
}

function smoothStep01(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export function marsJumpPoseWeights(
  anticipationSeconds: number,
  airborne: boolean,
  airborneSeconds: number,
  verticalVelocityMps: number,
  landingSeconds: number,
): JumpPoseWeights {
  const anticipation = anticipationSeconds > 0
    ? smoothStep01(1 - anticipationSeconds / MARS_JUMP_ANTICIPATION_DURATION_S)
    : 0;
  const launch = airborne
    ? 1 - smoothStep01(airborneSeconds / JUMP_LAUNCH_POSE_RELEASE_S)
    : 0;
  const landing = smoothStep01(landingSeconds / JUMP_LANDING_POSE_DURATION_S) * 0.58;
  const descent = airborne
    ? smoothStep01((-verticalVelocityMps - 0.2) / 1.8)
    : 0;
  return {
    squat: Math.max(anticipation, launch, landing),
    descent,
  };
}

export function applyWowCameraDrag(
  cameraYawRad: number,
  cameraPitchRad: number,
  headingRad: number,
  deltaX: number,
  deltaY: number,
  steeringCharacter: boolean,
) {
  // In this ENU/cube-sphere basis, increasing yaw renders as a screen-left
  // turn. Match pointer motion directly: left drag decreases yaw and right
  // drag increases it.
  const nextCameraYawRad = cameraYawRad + deltaX * 0.0042;
  return {
    cameraYawRad: nextCameraYawRad,
    cameraPitchRad: clamp(
      cameraPitchRad - deltaY * 0.0032,
      CAMERA_MIN_PITCH_RAD,
      CAMERA_MAX_PITCH_RAD,
    ),
    headingRad: steeringCharacter ? nextCameraYawRad : headingRad,
  };
}

export function wowMouseAutoRun(leftMouseHeld: boolean, rightMouseHeld: boolean) {
  return leftMouseHeld && rightMouseHeld;
}

export function isWowAutoRunKey(code: string) {
  return code === "NumLock" || code === "KeyR";
}

export function applyWowCameraZoom(cameraDistanceM: number, wheelDeltaPixels: number) {
  if (!Number.isFinite(cameraDistanceM) || !Number.isFinite(wheelDeltaPixels) || wheelDeltaPixels === 0) {
    return clamp(cameraDistanceM, CAMERA_FIRST_PERSON_DISTANCE_M, CAMERA_MAX_DISTANCE_M);
  }
  if (wheelDeltaPixels > 0 && cameraDistanceM <= CAMERA_FIRST_PERSON_DISTANCE_M) {
    return CAMERA_FIRST_PERSON_EXIT_DISTANCE_M;
  }

  const nextDistanceM = clamp(
    cameraDistanceM * Math.exp(wheelDeltaPixels * 0.0012),
    CAMERA_FIRST_PERSON_DISTANCE_M,
    CAMERA_MAX_DISTANCE_M,
  );
  if (wheelDeltaPixels < 0 && nextDistanceM <= CAMERA_FIRST_PERSON_ENTER_DISTANCE_M) {
    return CAMERA_FIRST_PERSON_DISTANCE_M;
  }
  return nextDistanceM;
}

export function rebaseCameraAnchorForTerrainChange(
  cameraAnchorHeightM: number,
  desiredCameraAnchorHeightM: number,
  thresholdM = CAMERA_TERRAIN_REBASE_THRESHOLD_M,
) {
  if (
    !Number.isFinite(cameraAnchorHeightM) ||
    !Number.isFinite(desiredCameraAnchorHeightM) ||
    Math.abs(desiredCameraAnchorHeightM - cameraAnchorHeightM) < Math.max(0, thresholdM)
  ) return cameraAnchorHeightM;
  return desiredCameraAnchorHeightM;
}

export function wowCameraOrbitDistances(cameraPitchRad: number, cameraDistanceM: number) {
  return {
    horizontalM: Math.cos(cameraPitchRad) * cameraDistanceM,
    verticalM: -Math.sin(cameraPitchRad) * cameraDistanceM,
  };
}

export type CameraHeightMotion = {
  heightM: number;
  velocityMps: number;
};

/**
 * Critically damped vertical camera motion with a bounded catch-up speed.
 * Unlike a first-order lerp, this preserves velocity between frames, so a
 * streaming/triangle height change cannot instantly change camera velocity.
 */
export function smoothCameraHeight(
  currentHeightM: number,
  targetHeightM: number,
  currentVelocityMps: number,
  deltaSeconds: number,
  smoothTimeS = CAMERA_HEIGHT_SMOOTH_TIME_S,
  maxSpeedMps = CAMERA_MAX_HEIGHT_SPEED_M_S,
): CameraHeightMotion {
  const delta = Math.max(0, deltaSeconds);
  if (delta === 0) return { heightM: currentHeightM, velocityMps: currentVelocityMps };

  const smoothTime = Math.max(0.0001, smoothTimeS);
  const omega = 2 / smoothTime;
  const scaledDelta = omega * delta;
  const decay = 1 / (1 + scaledDelta + 0.48 * scaledDelta ** 2 + 0.235 * scaledDelta ** 3);
  const originalTarget = targetHeightM;
  const maximumChange = Math.max(0, maxSpeedMps) * smoothTime;
  const change = clamp(currentHeightM - targetHeightM, -maximumChange, maximumChange);
  const boundedTarget = currentHeightM - change;
  const temporaryVelocity = (currentVelocityMps + omega * change) * delta;
  let velocityMps = (currentVelocityMps - omega * temporaryVelocity) * decay;
  let heightM = boundedTarget + (change + temporaryVelocity) * decay;

  // Numerical protection against crossing a stationary target on a long frame.
  if ((originalTarget - currentHeightM > 0) === (heightM > originalTarget)) {
    heightM = originalTarget;
    velocityMps = 0;
  }
  return { heightM, velocityMps };
}

/**
 * A curved-world third-person character controller. Absolute coordinates are
 * retained for physics, while the astronaut is rendered relative to the
 * camera-origin used by the planet renderer.
 */
export class SurfaceTraverseController {
  private readonly root = new THREE.Group();
  private readonly localFill = new THREE.HemisphereLight(0xdce8ff, 0x40180d, 0.72);
  private readonly direction = new THREE.Vector3(1, 0, 0);
  private readonly cameraAbsolute = new THREE.Vector3();
  private readonly desiredCameraAbsolute = new THREE.Vector3();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly footAbsolute = new THREE.Vector3();
  private readonly playerAbsolute = new THREE.Vector3();
  private readonly targetAbsolute = new THREE.Vector3();
  private readonly north = new THREE.Vector3();
  private readonly east = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly surfaceNormal = new THREE.Vector3(1, 0, 0);
  private readonly sampledSurfaceNormal = new THREE.Vector3(1, 0, 0);
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly modelForward = new THREE.Vector3();
  private readonly modelRight = new THREE.Vector3();
  private readonly move = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly cameraSurfaceDirection = new THREE.Vector3();
  private readonly relativeTarget = new THREE.Vector3();
  private readonly orientation = new THREE.Matrix4();
  private readonly poseEuler = new THREE.Euler();
  private readonly poseQuaternion = new THREE.Quaternion();
  private readonly poseWorldQuaternion = new THREE.Quaternion();
  private readonly poseHip = new THREE.Vector3();
  private readonly poseKnee = new THREE.Vector3();
  private readonly poseEnd = new THREE.Vector3();
  private readonly poseFoot = new THREE.Vector3();
  private readonly poseAxis = new THREE.Vector3();
  private readonly poseBend = new THREE.Vector3();
  private readonly poseDesiredKnee = new THREE.Vector3();
  private readonly poseDirection = new THREE.Vector3();
  private readonly poseLocalDirection = new THREE.Vector3();
  private readonly keys = new Set<string>();
  private readonly mouseButtons = new Set<number>();
  private readonly actions = new Map<AnimationName, THREE.AnimationAction>();
  private readonly poseBones = new Map<string, THREE.Bone>();
  private mixer: THREE.AnimationMixer | null = null;
  private currentAction: THREE.AnimationAction | null = null;
  private model: THREE.Object3D | null = null;
  private pointerId: number | null = null;
  private pointerX = 0;
  private pointerY = 0;
  private headingRad = 0;
  private cameraYawRad = 0;
  private cameraPitchRad = CAMERA_INITIAL_LOOK_PITCH_RAD;
  private cameraDistanceM = CAMERA_DEFAULT_DISTANCE_M;
  private cameraAnchorHeightM = 0;
  private cameraAnchorVelocityMps = 0;
  private cameraAnchorInitialized = false;
  private cameraCollisionFraction = 1;
  private surfaceNormalInitialized = false;
  private verticalOffsetM = 0;
  private verticalVelocityMps = 0;
  private jumpAnticipationSeconds = 0;
  private airborneSeconds = 0;
  private landingSeconds = 0;
  private footstepCountdown = 0;
  private groundHeightM = 0;
  private surveyFovDegrees: number;
  private autoRun = false;
  private entryWheelLockSeconds = 0;
  private entryReady = false;
  private entryStableSeconds = 0;
  private entryElapsedSeconds = 0;
  private entryPreviousGroundHeightM = Number.NaN;
  private disposed = false;
  active = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly terrainSurface: (direction: Vec3) => TraverseSurfaceSample,
    private readonly prefetch: (direction: Vec3) => void,
    private readonly onAssetError: (message: string) => void,
    private readonly onAudioEvent: (event: TraverseAudioEvent) => void = () => undefined,
  ) {
    this.surveyFovDegrees = camera.fov;
    this.root.name = "Surface traverse astronaut";
    this.root.visible = false;
    this.localFill.name = "Astronaut suit fill";
    this.localFill.visible = false;
    scene.add(this.root, this.localFill);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    void this.loadModel();
  }

  private async loadModel() {
    try {
      const gltf = await new GLTFLoader().loadAsync("/models/astronaut.glb?v=human-spacesuit-v1");
      if (this.disposed) return;
      this.model = gltf.scene;
      this.model.name = "Quaternius CC0 astronaut";
      this.model.updateMatrixWorld(true);

      const bounds = new THREE.Box3().setFromObject(this.model);
      const sourceHeight = Math.max(0.001, bounds.max.y - bounds.min.y);
      this.model.scale.multiplyScalar(PLAYER_HEIGHT_M / sourceHeight);
      this.model.updateMatrixWorld(true);
      bounds.setFromObject(this.model);
      const center = bounds.getCenter(new THREE.Vector3());
      this.model.position.set(-center.x, -bounds.min.y, -center.z);
      this.model.traverse((child) => {
        if (child instanceof THREE.Bone) this.poseBones.set(child.name, child);
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          child.frustumCulled = false;
        }
      });
      this.root.add(this.model);

      this.mixer = new THREE.AnimationMixer(this.model);
      for (const clip of gltf.animations) {
        const suffix = clip.name.split("|").at(-1)?.toLowerCase();
        if (!suffix || !["idle", "idle_neutral", "walk", "run", "jump", "jump_idle", "jump_land"].includes(suffix)) continue;
        this.actions.set(suffix as AnimationName, this.mixer.clipAction(clip));
      }
      this.playAnimation("idle", 0);
    } catch (error) {
      console.error("Unable to load the CC0 astronaut", error);
      this.onAssetError("The CC0 astronaut model could not be loaded.");
    }
  }

  teleportRandom(random: () => number = Math.random) {
    this.teleportTo(randomMarsSurfaceDirection(random), random() * Math.PI * 2);
  }

  teleportTo(targetDirection: Vec3, headingRad = Math.random() * Math.PI * 2) {
    const wasActive = this.active;
    const next = normalizeMarsSurfaceDirection(targetDirection);
    this.direction.set(next.x, next.y, next.z);
    this.headingRad = headingRad;
    this.cameraYawRad = this.headingRad;
    this.cameraPitchRad = CAMERA_INITIAL_LOOK_PITCH_RAD;
    this.cameraDistanceM = CAMERA_DEFAULT_DISTANCE_M;
    this.cameraAnchorVelocityMps = 0;
    this.cameraAnchorInitialized = false;
    this.cameraCollisionFraction = 1;
    this.surfaceNormalInitialized = false;
    this.verticalOffsetM = 0;
    this.verticalVelocityMps = 0;
    this.jumpAnticipationSeconds = 0;
    this.airborneSeconds = 0;
    this.landingSeconds = 0;
    this.footstepCountdown = 0;
    this.keys.clear();
    this.mouseButtons.clear();
    this.autoRun = false;
    this.entryWheelLockSeconds = CAMERA_ENTRY_WHEEL_LOCK_S;
    this.entryReady = false;
    this.entryStableSeconds = 0;
    this.entryElapsedSeconds = 0;
    this.entryPreviousGroundHeightM = Number.NaN;
    this.active = true;
    this.root.visible = true;
    this.localFill.visible = true;
    if (!wasActive) this.surveyFovDegrees = this.camera.fov;
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
    this.groundHeightM = this.terrainSurface(this.direction).heightM;
    this.prefetch(this.direction);
    this.canvas.focus({ preventScroll: true });
    this.playAnimation("idle");
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.root.visible = false;
    this.localFill.visible = false;
    this.keys.clear();
    this.mouseButtons.clear();
    this.autoRun = false;
    this.camera.fov = this.surveyFovDegrees;
    this.camera.updateProjectionMatrix();
  }

  getSurfaceDirection(): Vec3 {
    return { x: this.direction.x, y: this.direction.y, z: this.direction.z };
  }

  get surfaceReady() {
    return !this.active || this.entryReady;
  }

  private setLocalBasis() {
    const basis = localEnuBasis(
      THREE.MathUtils.radToDeg(Math.asin(clamp(this.direction.y, -1, 1))),
      THREE.MathUtils.radToDeg(Math.atan2(this.direction.z, this.direction.x)),
    );
    this.up.copy(this.direction);
    this.north.set(basis.north.x, basis.north.y, basis.north.z).normalize();
    this.east.set(basis.east.x, basis.east.y, basis.east.z).normalize();
  }

  private headingVector(yawRad: number, target: THREE.Vector3) {
    return target.copy(this.north).multiplyScalar(Math.cos(yawRad))
      .addScaledVector(this.east, Math.sin(yawRad)).normalize();
  }

  private updateMovement(deltaSeconds: number) {
    const rightMouse = this.mouseButtons.has(2);
    const turnLeft = this.keys.has("KeyA") || this.keys.has("ArrowLeft");
    const turnRight = this.keys.has("KeyD") || this.keys.has("ArrowRight");
    if (!rightMouse) {
      const turn = Number(turnRight) - Number(turnLeft);
      if (turn !== 0) {
        const angle = turn * deltaSeconds * 1.9;
        this.headingRad += angle;
        this.cameraYawRad += angle;
      }
    }

    let forwardInput = Number(this.autoRun || this.keys.has("KeyW") || this.keys.has("ArrowUp"))
      - Number(this.keys.has("KeyS") || this.keys.has("ArrowDown"));
    if (wowMouseAutoRun(this.mouseButtons.has(0), rightMouse)) forwardInput += 1;
    let strafeInput = Number(this.keys.has("KeyE")) - Number(this.keys.has("KeyQ"));
    if (rightMouse) strafeInput += Number(turnRight) - Number(turnLeft);
    if (forwardInput === 0 && strafeInput === 0) return 0;

    const inputLength = Math.hypot(forwardInput, strafeInput);
    forwardInput /= Math.max(1, inputLength);
    strafeInput /= Math.max(1, inputLength);
    this.headingVector(this.headingRad, this.forward);
    this.right.crossVectors(this.up, this.forward).normalize();
    this.move.copy(this.forward).multiplyScalar(forwardInput).addScaledVector(this.right, strafeInput).normalize();

    let speedMps = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? RUN_SPEED_M_S : WALK_SPEED_M_S;
    if (forwardInput < 0) speedMps *= 0.62;
    const angularDistance = speedMps * deltaSeconds / Math.max(1, MARS_REFERENCE_RADIUS_M + this.groundHeightM);
    this.direction.addScaledVector(this.move, angularDistance).normalize();
    this.prefetch(this.direction);
    return speedMps;
  }

  private updateJump(deltaSeconds: number) {
    let physicsDeltaSeconds = deltaSeconds;
    if (this.jumpAnticipationSeconds > 0) {
      this.jumpAnticipationSeconds -= deltaSeconds;
      if (this.jumpAnticipationSeconds > 0) return false;

      // Preserve the complete ballistic arc even when the anticipation timer
      // expires part-way through a rendered frame.
      physicsDeltaSeconds = Math.max(0, -this.jumpAnticipationSeconds);
      this.jumpAnticipationSeconds = 0;
      this.verticalVelocityMps = MARS_TRAVERSE_JUMP_SPEED_M_S;
      this.verticalOffsetM = 0.001;
      this.airborneSeconds = 0;
      this.onAudioEvent({ type: "jump" });
    }
    if (this.verticalOffsetM <= 0 && this.verticalVelocityMps <= 0) {
      this.verticalOffsetM = 0;
      return false;
    }
    this.airborneSeconds += physicsDeltaSeconds;
    this.verticalVelocityMps -= MARS_SURFACE_GRAVITY_M_S2 * physicsDeltaSeconds;
    this.verticalOffsetM += this.verticalVelocityMps * physicsDeltaSeconds;
    if (this.verticalOffsetM <= 0) {
      this.verticalOffsetM = 0;
      this.verticalVelocityMps = 0;
      this.airborneSeconds = 0;
      this.landingSeconds = JUMP_LANDING_POSE_DURATION_S;
      this.footstepCountdown = 0;
      this.onAudioEvent({ type: "land" });
      return false;
    }
    return true;
  }

  private updateAnimation(speedMps: number, airborne: boolean, deltaSeconds: number) {
    if (this.jumpAnticipationSeconds > 0 || airborne) {
      // The locomotion idle uses an asymmetric stance with the left boot
      // turned sharply outward. The asset's neutral idle gives the procedural
      // jump rig parallel feet and a symmetric ankle-aligned base pose.
      this.playAnimation("idle_neutral", 0.1);
    } else if (this.landingSeconds > 0) {
      this.landingSeconds = Math.max(0, this.landingSeconds - deltaSeconds);
      this.playAnimation("idle_neutral", 0.1);
    } else if (speedMps >= RUN_SPEED_M_S - 0.1) {
      this.playAnimation("run");
    } else if (speedMps > 0) {
      this.playAnimation("walk");
    } else {
      this.playAnimation("idle");
    }
    this.mixer?.update(deltaSeconds);
    this.applyJumpPose(airborne);
  }

  private rotatePoseBone(name: string, xDegrees: number, yDegrees: number, zDegrees: number, weight: number) {
    if (weight <= 0) return;
    const bone = this.poseBones.get(name);
    if (!bone) return;
    this.poseEuler.set(
      THREE.MathUtils.degToRad(xDegrees * weight),
      THREE.MathUtils.degToRad(yDegrees * weight),
      THREE.MathUtils.degToRad(zDegrees * weight),
    );
    this.poseQuaternion.setFromEuler(this.poseEuler);
    bone.quaternion.multiply(this.poseQuaternion);
  }

  private aimPoseBoneAtWorldPoint(bone: THREE.Bone, child: THREE.Object3D, target: THREE.Vector3) {
    bone.getWorldPosition(this.poseDirection);
    this.poseDirection.subVectors(target, this.poseDirection).normalize();
    bone.getWorldQuaternion(this.poseWorldQuaternion).invert();
    this.poseDirection.applyQuaternion(this.poseWorldQuaternion);
    this.poseLocalDirection.copy(child.position).normalize();
    this.poseQuaternion.setFromUnitVectors(this.poseLocalDirection, this.poseDirection);
    bone.quaternion.multiply(this.poseQuaternion);
    bone.updateWorldMatrix(true, true);
  }

  private plantFoot(side: "L" | "R") {
    const upperLeg = this.poseBones.get(`UpperLeg${side}`);
    const lowerLeg = this.poseBones.get(`LowerLeg${side}`);
    const foot = this.poseBones.get(`Foot${side}`);
    const lowerLegEnd = lowerLeg?.children[0];
    if (!upperLeg || !lowerLeg || !lowerLegEnd || !foot || !this.model) return;

    upperLeg.updateWorldMatrix(true, true);
    foot.updateWorldMatrix(true, false);
    upperLeg.getWorldPosition(this.poseHip);
    lowerLeg.getWorldPosition(this.poseKnee);
    lowerLegEnd.getWorldPosition(this.poseEnd);
    foot.getWorldPosition(this.poseFoot);
    const upperLength = this.poseHip.distanceTo(this.poseKnee);
    const lowerLength = this.poseKnee.distanceTo(this.poseEnd);

    this.poseAxis.subVectors(this.poseFoot, this.poseHip);
    const targetDistance = this.poseAxis.length();
    if (targetDistance <= 1e-6 || upperLength <= 1e-6 || lowerLength <= 1e-6) return;
    this.poseAxis.multiplyScalar(1 / targetDistance);

    // The asset is authored facing local +Z. Use that exact forward axis as
    // the IK pole so the knee travels over the toes, never inward toward the
    // other leg. Mirroring the right pole introduced a small sideways bias.
    this.poseBend.set(0, 0, 1);
    this.model.getWorldQuaternion(this.poseWorldQuaternion);
    this.poseBend.applyQuaternion(this.poseWorldQuaternion);
    this.poseBend.addScaledVector(this.poseAxis, -this.poseBend.dot(this.poseAxis));
    if (this.poseBend.lengthSq() <= 1e-8) {
      this.poseBend.set(1, 0, 0);
      this.model.getWorldQuaternion(this.poseWorldQuaternion);
      this.poseBend.applyQuaternion(this.poseWorldQuaternion);
      this.poseBend.addScaledVector(this.poseAxis, -this.poseBend.dot(this.poseAxis));
    }
    this.poseBend.normalize();

    const reachableDistance = clamp(
      targetDistance,
      Math.abs(upperLength - lowerLength) + 1e-5,
      upperLength + lowerLength - 1e-5,
    );
    const kneeAlongAxis = (
      upperLength ** 2 - lowerLength ** 2 + reachableDistance ** 2
    ) / (2 * reachableDistance);
    const kneeAwayFromAxis = Math.sqrt(Math.max(0, upperLength ** 2 - kneeAlongAxis ** 2));
    this.poseDesiredKnee.copy(this.poseHip)
      .addScaledVector(this.poseAxis, kneeAlongAxis)
      .addScaledVector(this.poseBend, kneeAwayFromAxis);

    this.aimPoseBoneAtWorldPoint(upperLeg, lowerLeg, this.poseDesiredKnee);
    this.aimPoseBoneAtWorldPoint(lowerLeg, lowerLegEnd, this.poseFoot);
  }

  private applyJumpPose(airborne: boolean) {
    const weights = marsJumpPoseWeights(
      this.jumpAnticipationSeconds,
      airborne,
      this.airborneSeconds,
      this.verticalVelocityMps,
      this.landingSeconds,
    );

    if (weights.squat > 0) {
      const body = this.poseBones.get("Body");
      if (body) body.position.y -= 0.0028 * weights.squat;
      this.rotatePoseBone("Chest", 7, 0, 0, weights.squat);
      this.rotatePoseBone("UpperArmL", 0, 0, 16, weights.squat);
      this.rotatePoseBone("UpperArmR", 0, 0, -16, weights.squat);
    }

    if (weights.descent > 0) {
      // Spread the arms forward and away from the torso as downward speed
      // builds, while keeping a little flex in the knees for the landing.
      this.rotatePoseBone("Chest", 8, 0, 0, weights.descent);
      this.rotatePoseBone("UpperArmL", 24, 0, -28, weights.descent);
      this.rotatePoseBone("LowerArmL", 0, 0, -16, weights.descent);
      this.rotatePoseBone("UpperArmR", 24, 0, 28, weights.descent);
      this.rotatePoseBone("LowerArmR", 0, 0, 16, weights.descent);
    }

    if (weights.squat > 0 || weights.descent > 0) {
      this.plantFoot("L");
      this.plantFoot("R");
    }
  }

  private updateFootsteps(speedMps: number, airborne: boolean, deltaSeconds: number) {
    if (airborne || this.landingSeconds > 0 || speedMps <= 0) {
      this.footstepCountdown = 0;
      return;
    }
    this.footstepCountdown -= deltaSeconds;
    if (this.footstepCountdown > 0) return;
    const running = speedMps >= RUN_SPEED_M_S - 0.1;
    this.onAudioEvent({ type: "step", running });
    const cadenceSeconds = running ? 0.34 : 0.52;
    this.footstepCountdown = cadenceSeconds * (0.94 + Math.random() * 0.12);
  }

  private playAnimation(name: AnimationName, fadeSeconds = 0.16) {
    const next = this.actions.get(name) ?? this.actions.get(name === "run" ? "walk" : "idle");
    if (!next || next === this.currentAction) return;
    const oneShot = name === "jump" || name === "jump_land";
    next.enabled = true;
    next.reset();
    next.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, oneShot ? 1 : Infinity);
    next.clampWhenFinished = oneShot;
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(name === "walk" ? 1.15 : name === "run" ? 1.05 : 1);
    if (fadeSeconds > 0) next.fadeIn(fadeSeconds);
    next.play();
    if (this.currentAction) this.currentAction.fadeOut(fadeSeconds);
    this.currentAction = next;
  }

  private safeCameraCollisionFraction(desiredCameraAbsolute: THREE.Vector3) {
    let lastSafeFraction = 0;
    for (let sampleIndex = 1; sampleIndex <= CAMERA_COLLISION_SAMPLES; sampleIndex += 1) {
      const fraction = sampleIndex / CAMERA_COLLISION_SAMPLES;
      this.scratch.lerpVectors(this.targetAbsolute, desiredCameraAbsolute, fraction);
      this.cameraSurfaceDirection.copy(this.scratch).normalize();
      const surfaceHeightM = this.terrainSurface(this.cameraSurfaceDirection).heightM;
      const minimumRadiusM = MARS_REFERENCE_RADIUS_M + surfaceHeightM + CAMERA_COLLISION_CLEARANCE_M;
      if (this.scratch.lengthSq() < minimumRadiusM * minimumRadiusM) return lastSafeFraction;
      lastSafeFraction = fraction;
    }
    return 1;
  }

  update(deltaSeconds: number): PlanetControlState {
    const delta = clamp(deltaSeconds, 0, 0.05);
    this.entryWheelLockSeconds = Math.max(0, this.entryWheelLockSeconds - delta);
    this.setLocalBasis();
    const speedMps = this.jumpAnticipationSeconds > 0 ? 0 : this.updateMovement(delta);
    this.setLocalBasis();
    const airborne = this.updateJump(delta);
    this.updateAnimation(speedMps, airborne, delta);
    this.updateFootsteps(speedMps, airborne || this.jumpAnticipationSeconds > 0, delta);

    const surface = this.terrainSurface(this.direction);
    this.groundHeightM = surface.heightM;
    if (!this.entryReady) {
      this.entryElapsedSeconds += delta;
      const heightStable = Number.isFinite(this.entryPreviousGroundHeightM) &&
        Math.abs(this.groundHeightM - this.entryPreviousGroundHeightM) <= Math.max(0.05, delta * 0.35);
      this.entryStableSeconds = (surface.lod ?? 0) >= ENTRY_READY_MIN_LOD && heightStable
        ? this.entryStableSeconds + delta
        : 0;
      this.entryPreviousGroundHeightM = this.groundHeightM;
      if (this.entryStableSeconds >= ENTRY_READY_STABLE_S || this.entryElapsedSeconds >= ENTRY_READY_MAX_WAIT_S) {
        this.entryReady = true;
        this.cameraAnchorInitialized = false;
        this.cameraCollisionFraction = 1;
      }
    }
    this.sampledSurfaceNormal.set(surface.normal.x, surface.normal.y, surface.normal.z).normalize();
    if (this.sampledSurfaceNormal.dot(this.direction) < 0) this.sampledSurfaceNormal.negate();
    if (!this.surfaceNormalInitialized) {
      this.surfaceNormal.copy(this.sampledSurfaceNormal);
      this.surfaceNormalInitialized = true;
    } else {
      const normalBlend = 1 - Math.exp(-delta * SURFACE_NORMAL_FOLLOW_RATE);
      this.surfaceNormal.lerp(this.sampledSurfaceNormal, normalBlend).normalize();
    }
    const groundRadiusM = MARS_REFERENCE_RADIUS_M + this.groundHeightM;
    this.footAbsolute.copy(this.direction).multiplyScalar(groundRadiusM);
    this.playerAbsolute.copy(this.footAbsolute).addScaledVector(
      this.surfaceNormal,
      this.verticalOffsetM + BOOT_SOLE_CLEARANCE_M,
    );

    this.headingVector(this.headingRad, this.forward);
    this.modelForward.copy(this.forward)
      .addScaledVector(this.surfaceNormal, -this.forward.dot(this.surfaceNormal))
      .normalize();
    this.modelRight.crossVectors(this.surfaceNormal, this.modelForward).normalize();
    this.orientation.makeBasis(this.modelRight, this.surfaceNormal, this.modelForward);
    // This astronaut asset is authored facing local +Z. The basis +Z axis is
    // the movement heading, so no additional half-turn belongs here.
    this.root.quaternion.setFromRotationMatrix(this.orientation);

    // The camera frame stays tangent to the smooth planetary radial direction.
    // Rendered triangle normals are intentionally excluded: they are piecewise
    // planar and can change during LOD morphs, which used to snap both camera
    // position and look direction at every terrain-normal discontinuity.
    this.headingVector(this.cameraYawRad, this.forward);
    const firstPerson = this.cameraDistanceM <= CAMERA_FIRST_PERSON_DISTANCE_M;
    this.root.visible = this.active && this.entryReady && !firstPerson;
    const targetHeightM = firstPerson ? CAMERA_FIRST_PERSON_HEIGHT_M : CAMERA_TARGET_HEIGHT_M;
    const desiredCameraAnchorHeightM = this.groundHeightM + this.verticalOffsetM +
      BOOT_SOLE_CLEARANCE_M + targetHeightM;
    if (!this.cameraAnchorInitialized) {
      this.cameraAnchorHeightM = desiredCameraAnchorHeightM;
      this.cameraAnchorVelocityMps = 0;
      this.cameraAnchorInitialized = true;
    } else {
      const rebasedCameraAnchorHeightM = rebaseCameraAnchorForTerrainChange(
        this.cameraAnchorHeightM,
        desiredCameraAnchorHeightM,
      );
      if (rebasedCameraAnchorHeightM !== this.cameraAnchorHeightM) {
        this.cameraAnchorHeightM = rebasedCameraAnchorHeightM;
        this.cameraAnchorVelocityMps = 0;
      } else {
        const heightMotion = smoothCameraHeight(
          this.cameraAnchorHeightM,
          desiredCameraAnchorHeightM,
          this.cameraAnchorVelocityMps,
          delta,
        );
        this.cameraAnchorHeightM = heightMotion.heightM;
        this.cameraAnchorVelocityMps = heightMotion.velocityMps;
      }
    }
    this.targetAbsolute.copy(this.direction).multiplyScalar(
      MARS_REFERENCE_RADIUS_M + this.cameraAnchorHeightM,
    );
    // WoW keeps the character at the orbit focus: pitch moves the physical
    // camera above/below that focus instead of merely tilting a fixed camera.
    // This is the visual difference between a true MMO follow camera and an
    // FPS-style freelook mounted on a third-person boom.
    const orbit = wowCameraOrbitDistances(this.cameraPitchRad, this.cameraDistanceM);
    this.desiredCameraAbsolute.copy(this.targetAbsolute)
      .addScaledVector(this.forward, -orbit.horizontalM)
      .addScaledVector(this.up, orbit.verticalM);

    // WoW-style collision shortens the camera boom toward the character. The
    // previous radial clamp put the camera on the terrain clearance floor and
    // jumped in/out whenever a streamed tile changed height behind the player.
    const safeCollisionFraction = firstPerson ? 1 : this.safeCameraCollisionFraction(this.desiredCameraAbsolute);
    if (safeCollisionFraction < this.cameraCollisionFraction) {
      this.cameraCollisionFraction = safeCollisionFraction;
    } else {
      this.cameraCollisionFraction = Math.min(
        safeCollisionFraction,
        this.cameraCollisionFraction + CAMERA_COLLISION_RECOVERY_RATE * delta,
      );
    }
    this.cameraAbsolute.lerpVectors(
      this.targetAbsolute,
      this.desiredCameraAbsolute,
      this.cameraCollisionFraction,
    );

    this.cameraSurfaceDirection.copy(this.cameraAbsolute).normalize();
    const cameraSurfaceHeightM = this.terrainSurface(this.cameraSurfaceDirection).heightM;

    this.cameraDirection.copy(this.cameraAbsolute).normalize();
    const cameraAltitudeM = Math.max(
      CAMERA_COLLISION_CLEARANCE_M,
      this.cameraAbsolute.length() - MARS_REFERENCE_RADIUS_M - cameraSurfaceHeightM,
    );

    this.root.position.copy(this.playerAbsolute).sub(this.cameraAbsolute);
    this.camera.position.set(0, 0, 0);
    this.camera.up.copy(this.up);
    if (firstPerson) {
      this.relativeTarget.copy(this.forward).multiplyScalar(Math.cos(this.cameraPitchRad))
        .addScaledVector(this.up, Math.sin(this.cameraPitchRad));
    } else {
      this.relativeTarget.copy(this.targetAbsolute).sub(this.cameraAbsolute).normalize();
    }
    this.camera.lookAt(this.relativeTarget);
    this.camera.near = 0.05;
    this.camera.far = Math.max(
      350_000,
      Math.sqrt(2 * MARS_REFERENCE_RADIUS_M * (cameraAltitudeM + MARS_ATMOSPHERE_TOP_M)) * 3.2,
    );
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    return {
      cameraAbsolute: { x: this.cameraAbsolute.x, y: this.cameraAbsolute.y, z: this.cameraAbsolute.z },
      cameraDirection: { x: this.cameraDirection.x, y: this.cameraDirection.y, z: this.cameraDirection.z },
      focusDirection: { x: this.direction.x, y: this.direction.y, z: this.direction.z },
      focusAbsolute: { x: this.footAbsolute.x, y: this.footAbsolute.y, z: this.footAbsolute.z },
      altitudeM: cameraAltitudeM,
      desiredAltitudeM: cameraAltitudeM,
      cameraDistanceM: this.cameraDistanceM * this.cameraCollisionFraction,
      nearM: this.camera.near,
      farM: this.camera.far,
    };
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (!this.active) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (isWowAutoRunKey(event.code)) {
      event.preventDefault();
      if (!event.repeat) this.autoRun = !this.autoRun;
      return;
    }
    if (["KeyW", "KeyS", "ArrowUp", "ArrowDown"].includes(event.code)) {
      this.autoRun = false;
    }
    if (["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
      event.preventDefault();
    }
    if (event.code === "Space") {
      event.preventDefault();
      if (
        !event.repeat &&
        this.jumpAnticipationSeconds === 0 &&
        this.verticalOffsetM <= 0.001 &&
        this.verticalVelocityMps === 0 &&
        this.landingSeconds === 0
      ) {
        this.jumpAnticipationSeconds = MARS_JUMP_ANTICIPATION_DURATION_S;
        this.airborneSeconds = 0;
        this.landingSeconds = 0;
        this.footstepCountdown = 0;
      }
    }
    this.keys.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private onBlur = () => {
    this.keys.clear();
    this.mouseButtons.clear();
    this.pointerId = null;
  };

  private onContextMenu = (event: MouseEvent) => {
    if (this.active) event.preventDefault();
  };

  private onPointerDown = (event: PointerEvent) => {
    if (!this.active || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault();
    this.mouseButtons.add(event.button);
    // A free-looked camera becomes the character's facing direction as soon
    // as RMB is depressed, even before the pointer moves. That also makes a
    // left+right mouse run advance toward the view immediately.
    if (event.button === 2) this.headingRad = this.cameraYawRad;
    this.pointerId = event.pointerId;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.active || this.pointerId !== event.pointerId) return;
    this.syncMouseButtons(event.buttons);
    if (this.mouseButtons.size === 0) return;
    const dx = event.clientX - this.pointerX;
    const dy = event.clientY - this.pointerY;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    const drag = applyWowCameraDrag(
      this.cameraYawRad,
      this.cameraPitchRad,
      this.headingRad,
      dx,
      dy,
      this.mouseButtons.has(2),
    );
    this.cameraYawRad = drag.cameraYawRad;
    this.cameraPitchRad = drag.cameraPitchRad;
    this.headingRad = drag.headingRad;
    event.preventDefault();
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.pointerId !== event.pointerId) return;
    this.syncMouseButtons(event.buttons);
    if (event.buttons === 0) {
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.pointerId = null;
      this.mouseButtons.clear();
    }
  };

  private syncMouseButtons(buttons: number) {
    if ((buttons & 1) !== 0) this.mouseButtons.add(0);
    else this.mouseButtons.delete(0);
    if ((buttons & 2) !== 0) this.mouseButtons.add(2);
    else this.mouseButtons.delete(2);
  }

  private onWheel = (event: WheelEvent) => {
    if (!this.active) return;
    event.preventDefault();
    if (this.entryWheelLockSeconds > 0) return;
    const modeScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 480 : 1;
    this.cameraDistanceM = applyWowCameraZoom(this.cameraDistanceM, event.deltaY * modeScale);
  };

  dispose() {
    this.disposed = true;
    this.deactivate();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.mixer?.stopAllAction();
    this.model?.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) material.dispose();
    });
    this.root.removeFromParent();
    this.localFill.removeFromParent();
  }
}
