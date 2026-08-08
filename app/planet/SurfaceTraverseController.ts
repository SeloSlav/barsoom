import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  MAX_CAMERA_ALTITUDE_M,
  MARS_ATMOSPHERE_TOP_M,
  MARS_MOON_MAX_ORBIT_RADIUS_M,
  MARS_REFERENCE_RADIUS_M,
  MARS_SURFACE_GRAVITY_M_S2,
  MARS_TRAVERSE_JUMP_SPEED_M_S,
} from "./constants";
import { clamp, localEnuBasis } from "./math";
import type { PlanetControlState } from "./PlanetControls";
import {
  SHIP_BOARD_DISTANCE_M,
  SurfaceSpaceship,
  spaceshipSteerAmount,
  type SpaceshipFlightInput,
} from "./SurfaceSpaceship";
import type { Vec3 } from "./types";
import type { TraverseAudioEvent } from "../audio/BarsoomAudio";

const WALK_SPEED_M_S = 4.2;
const RUN_SPEED_M_S = 7.2;
const PLAYER_HEIGHT_M = 1.82;
const CAMERA_DEFAULT_DISTANCE_M = 7;
const CAMERA_FIRST_PERSON_DISTANCE_M = 0;
const CAMERA_FIRST_PERSON_ENTER_DISTANCE_M = 0.85;
const CAMERA_FIRST_PERSON_EXIT_DISTANCE_M = 2.2;
const CAMERA_MAX_DISTANCE_M = MAX_CAMERA_ALTITUDE_M;
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
const SHIP_CAMERA_DEFAULT_DISTANCE_M = 24;
const SHIP_CAMERA_MIN_DISTANCE_M = 8;
const SHIP_CAMERA_MAX_DISTANCE_M = CAMERA_MAX_DISTANCE_M;
const SHIP_CAMERA_DEFAULT_PITCH_RAD = 0;
const SHIP_MOUSE_CAMERA_YAW_RATE_RAD_S = 1.9;
const SHIP_MOUSE_CAMERA_PITCH_RATE_RAD_S = 1.55;
const SHIP_FREE_LOOK_RETURN_RATE_S = 7;
const SHIP_EXIT_OFFSET_M = 4.2;
const SHIP_EXIT_GROUND_SNAP_M = 6;

type AnimationName = "idle" | "idle_neutral" | "jump_base" | "walk" | "run" | "jump" | "jump_idle" | "jump_land";

type JumpPoseWeights = {
  squat: number;
  descent: number;
};

export type TraverseSurfaceSample = {
  heightM: number;
  normal: Vec3;
  lod?: number;
};

export type SurfaceTraverseMode = "spaceman" | "spaceship";

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

export function wowStrafeInput(leftHeld: boolean, rightHeld: boolean) {
  return Number(rightHeld) - Number(leftHeld);
}

/**
 * Three.js cameras look down local -Z, so their screen-right axis is forward
 * cross up. Using up cross forward mirrors Q/E relative to the player's view.
 */
export function surfaceCameraRight(forward: Vec3, up: Vec3): Vec3 {
  const right = {
    x: forward.y * up.z - forward.z * up.y,
    y: forward.z * up.x - forward.x * up.z,
    z: forward.x * up.y - forward.y * up.x,
  };
  const length = Math.hypot(right.x, right.y, right.z);
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    throw new RangeError("Surface camera forward and up axes must define a right direction.");
  }
  return { x: right.x / length, y: right.y / length, z: right.z / length };
}

export function isWowAutoRunKey(code: string) {
  return code === "NumLock" || code === "KeyR";
}

export type WowAutoMoveMode = "off" | "walk" | "run";

export function nextWowAutoMoveMode(mode: WowAutoMoveMode): WowAutoMoveMode {
  if (mode === "off") return "walk";
  if (mode === "walk") return "run";
  return "off";
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

export function applySpaceshipCameraZoom(cameraDistanceM: number, wheelDeltaPixels: number) {
  if (!Number.isFinite(cameraDistanceM) || !Number.isFinite(wheelDeltaPixels) || wheelDeltaPixels === 0) {
    return clamp(cameraDistanceM, SHIP_CAMERA_MIN_DISTANCE_M, SHIP_CAMERA_MAX_DISTANCE_M);
  }
  return clamp(
    cameraDistanceM * Math.exp(wheelDeltaPixels * 0.0012),
    SHIP_CAMERA_MIN_DISTANCE_M,
    SHIP_CAMERA_MAX_DISTANCE_M,
  );
}

export function applySpaceshipCameraOrbitDrag(
  cameraYawRad: number,
  cameraPitchRad: number,
  deltaX: number,
  deltaY: number,
) {
  return {
    // The camera sits on the negative orbit-forward vector. Subtracting both
    // drag deltas makes the camera itself follow the pointer around the craft.
    cameraYawRad: cameraYawRad - deltaX * 0.0042,
    // Deliberately unbounded: dragging vertically can loop over either pole
    // repeatedly instead of colliding with an invisible pitch wall.
    cameraPitchRad: cameraPitchRad - deltaY * 0.0032,
  };
}

export function spaceshipMouseForward(leftButton: boolean, rightButton: boolean) {
  return leftButton && rightButton;
}

export function applySpaceshipCameraPointerSteer(
  cameraYawRad: number,
  cameraPitchRad: number,
  aimX: number,
  aimY: number,
  deltaSeconds: number,
) {
  const delta = clamp(deltaSeconds, 0, 0.05);
  return {
    cameraYawRad: cameraYawRad
      - spaceshipSteerAmount(aimX) * SHIP_MOUSE_CAMERA_YAW_RATE_RAD_S * delta,
    cameraPitchRad: cameraPitchRad
      + spaceshipSteerAmount(aimY) * SHIP_MOUSE_CAMERA_PITCH_RATE_RAD_S * delta,
  };
}

export function spaceshipAltFreeLook(
  altHeld: boolean,
  leftButton: boolean,
  middleButton: boolean,
  rightButton: boolean,
) {
  return altHeld && ((leftButton && !rightButton) || middleButton);
}

export function recenterSpaceshipFreeLook(angleRad: number, deltaSeconds: number) {
  const wrappedAngleRad = Math.atan2(Math.sin(angleRad), Math.cos(angleRad));
  const next = wrappedAngleRad * Math.exp(
    -SHIP_FREE_LOOK_RETURN_RATE_S * clamp(deltaSeconds, 0, 0.05),
  );
  return Math.abs(next) < 1e-4 ? 0 : next;
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
  private readonly spaceship: SurfaceSpaceship;
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
  private readonly shipAbsolute = new THREE.Vector3();
  private readonly shipForward = new THREE.Vector3();
  private readonly shipRight = new THREE.Vector3();
  private readonly shipUp = new THREE.Vector3();
  private readonly shipRadialUp = new THREE.Vector3();
  private readonly shipOrbitForward = new THREE.Vector3();
  private readonly shipOrbitRight = new THREE.Vector3();
  private readonly shipCameraBaseForward = new THREE.Vector3();
  private readonly shipCameraBaseRight = new THREE.Vector3();
  private readonly shipCameraBaseUp = new THREE.Vector3();
  private readonly shipCameraForward = new THREE.Vector3();
  private readonly shipCameraUp = new THREE.Vector3();
  private readonly shipViewForward = new THREE.Vector3();
  private readonly shipViewRight = new THREE.Vector3();
  private readonly shipViewUp = new THREE.Vector3();
  private readonly shipViewRotation = new THREE.Quaternion();
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
  private autoMoveMode: WowAutoMoveMode = "off";
  private entryWheelLockSeconds = 0;
  private entryReady = false;
  private entryStableSeconds = 0;
  private entryElapsedSeconds = 0;
  private entryPreviousGroundHeightM = Number.NaN;
  private traverseMode: SurfaceTraverseMode = "spaceman";
  private shipDistanceM: number | null = null;
  private shipCanBoard = false;
  private shipAimX = 0;
  private shipAimY = 0;
  private shipCameraDistanceM = SHIP_CAMERA_DEFAULT_DISTANCE_M;
  private shipCameraYawRad = 0;
  private shipCameraPitchRad = SHIP_CAMERA_DEFAULT_PITCH_RAD;
  private shipLookYawRad = 0;
  private shipLookPitchRad = 0;
  private shipBrakeRequested = false;
  private shipCruiseThrust = false;
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
    this.spaceship = new SurfaceSpaceship(scene, terrainSurface, prefetch, onAssetError);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
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
      let idleClip: THREE.AnimationClip | null = null;
      let neutralIdleClip: THREE.AnimationClip | null = null;
      for (const clip of gltf.animations) {
        const suffix = clip.name.split("|").at(-1)?.toLowerCase();
        if (!suffix || !["idle", "idle_neutral", "walk", "run", "jump", "jump_idle", "jump_land"].includes(suffix)) continue;
        if (suffix === "idle") idleClip = clip;
        if (suffix === "idle_neutral") neutralIdleClip = clip;
        this.actions.set(suffix as AnimationName, this.mixer.clipAction(clip));
      }
      if (idleClip && neutralIdleClip) {
        const lowerBodyTrack = /^(UpperLeg|LowerLeg|Foot)[LR]\./;
        const jumpBaseClip = new THREE.AnimationClip(
          "jump_base",
          Math.max(idleClip.duration, neutralIdleClip.duration),
          [
            ...idleClip.tracks.filter((track) => !lowerBodyTrack.test(track.name)),
            ...neutralIdleClip.tracks.filter((track) => lowerBodyTrack.test(track.name)),
          ].map((track) => track.clone()),
        );
        this.actions.set("jump_base", this.mixer.clipAction(jumpBaseClip));
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
    this.autoMoveMode = "off";
    this.entryWheelLockSeconds = CAMERA_ENTRY_WHEEL_LOCK_S;
    this.entryReady = false;
    this.entryStableSeconds = 0;
    this.entryElapsedSeconds = 0;
    this.entryPreviousGroundHeightM = Number.NaN;
    this.traverseMode = "spaceman";
    this.shipDistanceM = null;
    this.shipCanBoard = false;
    this.shipAimX = 0;
    this.shipAimY = 0;
    this.shipCameraDistanceM = SHIP_CAMERA_DEFAULT_DISTANCE_M;
    this.shipCameraYawRad = 0;
    this.shipCameraPitchRad = SHIP_CAMERA_DEFAULT_PITCH_RAD;
    this.shipLookYawRad = 0;
    this.shipLookPitchRad = 0;
    this.shipBrakeRequested = false;
    this.shipCruiseThrust = false;
    this.active = true;
    this.root.visible = true;
    this.localFill.visible = true;
    if (!wasActive) this.surveyFovDegrees = this.camera.fov;
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
    this.groundHeightM = this.terrainSurface(this.direction).heightM;
    this.setLocalBasis();
    this.headingVector(this.headingRad, this.forward);
    const spawnRight = surfaceCameraRight(this.forward, this.up);
    this.right.set(spawnRight.x, spawnRight.y, spawnRight.z);
    this.spaceship.spawnNear(this.direction, this.forward, this.right);
    this.prefetch(this.direction);
    this.canvas.focus({ preventScroll: true });
    this.playAnimation("idle");
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.root.visible = false;
    this.localFill.visible = false;
    this.spaceship.deactivate();
    this.keys.clear();
    this.mouseButtons.clear();
    this.shipLookYawRad = 0;
    this.shipLookPitchRad = 0;
    this.autoMoveMode = "off";
    this.camera.fov = this.surveyFovDegrees;
    this.camera.updateProjectionMatrix();
  }

  getSurfaceDirection(): Vec3 {
    return { x: this.direction.x, y: this.direction.y, z: this.direction.z };
  }

  getHeadingRad() {
    return this.headingRad;
  }

  get mode(): SurfaceTraverseMode {
    return this.traverseMode;
  }

  get spaceshipInteraction() {
    return {
      distanceM: this.shipDistanceM,
      canBoard: this.shipCanBoard,
      speedMps: this.traverseMode === "spaceship" ? this.spaceship.getSpeedMps() : 0,
    };
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

    let forwardInput = Number(this.autoMoveMode !== "off" || this.keys.has("KeyW") || this.keys.has("ArrowUp"))
      - Number(this.keys.has("KeyS") || this.keys.has("ArrowDown"));
    if (wowMouseAutoRun(this.mouseButtons.has(0), rightMouse)) forwardInput += 1;
    let strafeInput = wowStrafeInput(this.keys.has("KeyQ"), this.keys.has("KeyE"));
    if (rightMouse) strafeInput += Number(turnRight) - Number(turnLeft);
    if (forwardInput === 0 && strafeInput === 0) return 0;

    const inputLength = Math.hypot(forwardInput, strafeInput);
    forwardInput /= Math.max(1, inputLength);
    strafeInput /= Math.max(1, inputLength);
    this.headingVector(this.headingRad, this.forward);
    const screenRight = surfaceCameraRight(this.forward, this.up);
    this.right.set(screenRight.x, screenRight.y, screenRight.z);
    this.move.copy(this.forward).multiplyScalar(forwardInput).addScaledVector(this.right, strafeInput).normalize();

    const manualRun = this.autoMoveMode === "off" && (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"));
    let speedMps = this.autoMoveMode === "run" || manualRun ? RUN_SPEED_M_S : WALK_SPEED_M_S;
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
      // The jump base combines the regular idle's stable head/arms with only
      // the neutral idle's symmetric leg and parallel-foot tracks.
      this.playAnimation("jump_base", 0.1);
    } else if (this.landingSeconds > 0) {
      this.landingSeconds = Math.max(0, this.landingSeconds - deltaSeconds);
      this.playAnimation("jump_base", 0.1);
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

    if (weights.squat > 0) {
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

  private boardSpaceship() {
    if (this.traverseMode !== "spaceman" || !this.shipCanBoard) return;
    this.traverseMode = "spaceship";
    this.shipCanBoard = false;
    this.shipDistanceM = 0;
    this.shipAimX = 0;
    this.shipAimY = 0;
    this.shipCameraDistanceM = SHIP_CAMERA_DEFAULT_DISTANCE_M;
    this.shipCameraYawRad = 0;
    this.shipCameraPitchRad = SHIP_CAMERA_DEFAULT_PITCH_RAD;
    this.shipLookYawRad = 0;
    this.shipLookPitchRad = 0;
    this.shipBrakeRequested = false;
    this.shipCruiseThrust = false;
    this.cameraCollisionFraction = 1;
    this.keys.clear();
    this.mouseButtons.clear();
    this.autoMoveMode = "off";
    this.root.visible = false;
    this.spaceship.getForward(this.shipCameraBaseForward);
    this.spaceship.getRight(this.shipCameraBaseRight);
    this.spaceship.getUp(this.shipCameraBaseUp);
    this.updateShipCameraFrame();
    this.spaceship.board();
    this.camera.fov = 58;
    this.camera.updateProjectionMatrix();
  }

  disembarkSpaceship() {
    if (!this.active || this.traverseMode !== "spaceship") return false;

    this.spaceship.stopAndPark();
    this.spaceship.getAbsolute(this.shipAbsolute);
    this.spaceship.getForward(this.shipForward);
    this.spaceship.getRight(this.shipRight);
    const shipRadiusM = this.shipAbsolute.length();
    this.shipRadialUp.copy(this.shipAbsolute).normalize();
    this.shipOrbitRight.copy(this.shipRight)
      .addScaledVector(this.shipRadialUp, -this.shipRight.dot(this.shipRadialUp));
    if (this.shipOrbitRight.lengthSq() <= 1e-8) {
      this.shipOrbitRight.crossVectors(this.shipRadialUp, this.shipForward);
    }
    this.shipOrbitRight.normalize();
    this.direction.copy(this.shipAbsolute)
      .addScaledVector(this.shipOrbitRight, SHIP_EXIT_OFFSET_M)
      .normalize();

    const surface = this.terrainSurface(this.direction);
    this.groundHeightM = surface.heightM;
    const groundRadiusM = MARS_REFERENCE_RADIUS_M + this.groundHeightM;
    const shipAltitudeM = Math.max(0, shipRadiusM - groundRadiusM);
    this.verticalOffsetM = shipAltitudeM <= SHIP_EXIT_GROUND_SNAP_M
      ? 0
      : Math.max(0, shipAltitudeM - BOOT_SOLE_CLEARANCE_M);
    this.verticalVelocityMps = 0;
    this.jumpAnticipationSeconds = 0;
    this.airborneSeconds = 0;
    this.landingSeconds = 0;
    this.surfaceNormal.copy(this.direction);
    this.surfaceNormalInitialized = true;
    this.setLocalBasis();

    this.shipOrbitForward.copy(this.shipForward)
      .addScaledVector(this.direction, -this.shipForward.dot(this.direction));
    if (this.shipOrbitForward.lengthSq() <= 1e-8) this.shipOrbitForward.copy(this.north);
    this.shipOrbitForward.normalize();
    this.headingRad = Math.atan2(
      this.shipOrbitForward.dot(this.east),
      this.shipOrbitForward.dot(this.north),
    );
    this.shipOrbitForward.copy(this.shipCameraForward)
      .addScaledVector(this.direction, -this.shipCameraForward.dot(this.direction));
    if (this.shipOrbitForward.lengthSq() <= 1e-8) this.shipOrbitForward.copy(this.north);
    this.shipOrbitForward.normalize();
    this.cameraYawRad = Math.atan2(
      this.shipOrbitForward.dot(this.east),
      this.shipOrbitForward.dot(this.north),
    );
    this.cameraPitchRad = clamp(
      Math.asin(clamp(this.shipCameraForward.dot(this.direction), -1, 1)),
      CAMERA_MIN_PITCH_RAD,
      CAMERA_MAX_PITCH_RAD,
    );
    this.cameraDistanceM = clamp(
      this.shipCameraDistanceM,
      CAMERA_DEFAULT_DISTANCE_M,
      CAMERA_MAX_DISTANCE_M,
    );
    this.cameraAnchorInitialized = false;
    this.cameraCollisionFraction = 1;
    this.entryWheelLockSeconds = 0;
    this.traverseMode = "spaceman";
    this.shipDistanceM = SHIP_EXIT_OFFSET_M;
    this.shipCanBoard = this.verticalOffsetM <= 0.001;
    this.shipAimX = 0;
    this.shipAimY = 0;
    this.shipBrakeRequested = false;
    this.shipCruiseThrust = false;
    this.shipLookYawRad = 0;
    this.shipLookPitchRad = 0;
    this.keys.clear();
    this.mouseButtons.clear();
    this.pointerId = null;
    this.autoMoveMode = "off";
    this.root.visible = true;
    this.localFill.visible = true;
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
    this.prefetch(this.direction);
    this.playAnimation(this.verticalOffsetM > 0 ? "jump_base" : "idle");
    return true;
  }

  private updateShipCameraFrame() {
    this.shipOrbitForward.copy(this.shipCameraBaseForward)
      .multiplyScalar(Math.cos(this.shipCameraYawRad))
      .addScaledVector(this.shipCameraBaseRight, Math.sin(this.shipCameraYawRad))
      .normalize();
    this.shipCameraForward.copy(this.shipOrbitForward)
      .multiplyScalar(Math.cos(this.shipCameraPitchRad))
      .addScaledVector(this.shipCameraBaseUp, Math.sin(this.shipCameraPitchRad))
      .normalize();
    this.shipCameraUp.copy(this.shipCameraBaseUp)
      .multiplyScalar(Math.cos(this.shipCameraPitchRad))
      .addScaledVector(this.shipOrbitForward, -Math.sin(this.shipCameraPitchRad))
      .normalize();
  }

  private updateShipViewFrame() {
    this.shipViewForward.copy(this.shipCameraForward);
    this.shipViewUp.copy(this.shipCameraUp);
    this.shipViewRotation.setFromAxisAngle(this.shipCameraUp, this.shipLookYawRad);
    this.shipViewForward.applyQuaternion(this.shipViewRotation).normalize();
    this.shipViewUp.applyQuaternion(this.shipViewRotation).normalize();
    this.shipViewRight.crossVectors(this.shipViewForward, this.shipViewUp).normalize();
    this.shipViewRotation.setFromAxisAngle(this.shipViewRight, this.shipLookPitchRad);
    this.shipViewForward.applyQuaternion(this.shipViewRotation).normalize();
    this.shipViewUp.applyQuaternion(this.shipViewRotation).normalize();
  }

  private updateSpaceship(delta: number): PlanetControlState {
    const brakeRequested = this.shipBrakeRequested || this.keys.has("KeyX");
    this.shipBrakeRequested = false;
    const mouseForward = spaceshipMouseForward(
      this.mouseButtons.has(0),
      this.mouseButtons.has(2),
    );
    const cameraOrbiting = (this.mouseButtons.has(0) && !this.mouseButtons.has(2)) ||
      this.mouseButtons.has(1);
    const altHeld = this.keys.has("AltLeft") || this.keys.has("AltRight");
    if (!cameraOrbiting && !altHeld) {
      const cameraAim = applySpaceshipCameraPointerSteer(
        this.shipCameraYawRad,
        this.shipCameraPitchRad,
        this.shipAimX,
        this.shipAimY,
        delta,
      );
      this.shipCameraYawRad = cameraAim.cameraYawRad;
      this.shipCameraPitchRad = cameraAim.cameraPitchRad;
    }
    if (!altHeld) {
      this.shipLookYawRad = recenterSpaceshipFreeLook(this.shipLookYawRad, delta);
      this.shipLookPitchRad = recenterSpaceshipFreeLook(this.shipLookPitchRad, delta);
    }
    this.updateShipCameraFrame();
    this.updateShipViewFrame();
    const flightInput: SpaceshipFlightInput = {
      throttle: Number(this.shipCruiseThrust || this.keys.has("KeyW") || mouseForward)
        - Number(this.keys.has("KeyS")),
      strafe: Number(this.keys.has("KeyC")) - Number(this.keys.has("KeyZ")),
      lift: Number(this.keys.has("Space"))
        - Number(this.keys.has("ControlLeft") || this.keys.has("ControlRight")),
      yaw: Number(this.keys.has("KeyD") || this.keys.has("ArrowRight"))
        - Number(this.keys.has("KeyA") || this.keys.has("ArrowLeft")),
      pitch: Number(this.keys.has("ArrowUp")) - Number(this.keys.has("ArrowDown")),
      roll: Number(this.keys.has("KeyE")) - Number(this.keys.has("KeyQ")),
      boost: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"),
      brake: brakeRequested,
      aimX: 0,
      aimY: 0,
      aimDirection: {
        x: this.shipCameraForward.x,
        y: this.shipCameraForward.y,
        z: this.shipCameraForward.z,
      },
    };
    this.spaceship.updateFlight(delta, flightInput);
    this.spaceship.getAbsolute(this.shipAbsolute);
    this.spaceship.getForward(this.shipForward);
    this.spaceship.getRight(this.shipRight);
    this.spaceship.getUp(this.shipUp);
    this.direction.copy(this.shipAbsolute).normalize();
    this.shipRadialUp.copy(this.direction);
    const surface = this.terrainSurface(this.direction);
    this.groundHeightM = surface.heightM;

    this.targetAbsolute.copy(this.shipAbsolute).addScaledVector(this.shipRadialUp, 1.5);
    this.desiredCameraAbsolute.copy(this.targetAbsolute)
      .addScaledVector(this.shipViewForward, -this.shipCameraDistanceM);
    const safeCollisionFraction = this.safeCameraCollisionFraction(this.desiredCameraAbsolute);
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
    this.root.visible = false;
    this.camera.position.set(0, 0, 0);
    this.relativeTarget.copy(this.targetAbsolute).sub(this.cameraAbsolute).normalize();
    // This is the analytic up-vector of the orbit circle. It rolls through
    // both poles continuously, avoiding the former fallback-axis snap.
    this.camera.up.copy(this.shipViewUp);
    this.camera.lookAt(this.relativeTarget);
    this.camera.near = clamp(this.shipCameraDistanceM * 0.000001, 0.08, 30);
    this.camera.far = Math.max(
      350_000,
      Math.sqrt(2 * MARS_REFERENCE_RADIUS_M * (cameraAltitudeM + MARS_ATMOSPHERE_TOP_M)) * 3.2,
      this.cameraAbsolute.length() + MARS_MOON_MAX_ORBIT_RADIUS_M + 50_000,
    );
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.spaceship.syncVisual(this.cameraAbsolute);

    return {
      cameraAbsolute: { x: this.cameraAbsolute.x, y: this.cameraAbsolute.y, z: this.cameraAbsolute.z },
      cameraDirection: { x: this.cameraDirection.x, y: this.cameraDirection.y, z: this.cameraDirection.z },
      focusDirection: { x: this.direction.x, y: this.direction.y, z: this.direction.z },
      focusAbsolute: { x: this.shipAbsolute.x, y: this.shipAbsolute.y, z: this.shipAbsolute.z },
      altitudeM: cameraAltitudeM,
      desiredAltitudeM: cameraAltitudeM,
      cameraDistanceM: this.shipCameraDistanceM * this.cameraCollisionFraction,
      nearM: this.camera.near,
      farM: this.camera.far,
    };
  }

  update(deltaSeconds: number): PlanetControlState {
    const delta = clamp(deltaSeconds, 0, 0.05);
    if (this.traverseMode === "spaceship") return this.updateSpaceship(delta);
    this.entryWheelLockSeconds = Math.max(0, this.entryWheelLockSeconds - delta);
    this.spaceship.updateParkedPosition();
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
    this.shipDistanceM = this.spaceship.distanceTo(this.playerAbsolute);
    this.shipCanBoard = this.entryReady &&
      this.verticalOffsetM <= 0.001 &&
      this.jumpAnticipationSeconds === 0 &&
      this.shipDistanceM <= SHIP_BOARD_DISTANCE_M;

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
      this.cameraAbsolute.length() + MARS_MOON_MAX_ORBIT_RADIUS_M + 50_000,
    );
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.spaceship.syncVisual(this.cameraAbsolute);

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
    if (this.traverseMode === "spaceman" && event.code === "KeyE" && this.shipCanBoard && !event.repeat) {
      event.preventDefault();
      this.boardSpaceship();
      return;
    }
    if (this.traverseMode === "spaceship") {
      if (event.code === "KeyR" && !event.repeat) {
        event.preventDefault();
        this.shipCruiseThrust = !this.shipCruiseThrust;
        return;
      }
      if ([
        "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyZ", "KeyC", "KeyX", "Space",
        "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight",
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      ].includes(event.code)) event.preventDefault();
      if (event.code === "KeyX" && !event.repeat) {
        this.shipBrakeRequested = true;
        this.shipCruiseThrust = false;
      }
      if (event.code === "KeyS") this.shipCruiseThrust = false;
      this.keys.add(event.code);
      return;
    }
    if (event.code === "KeyR") {
      event.preventDefault();
      if (!event.repeat) this.autoMoveMode = nextWowAutoMoveMode(this.autoMoveMode);
      return;
    }
    if (event.code === "NumLock") {
      event.preventDefault();
      if (!event.repeat) this.autoMoveMode = this.autoMoveMode === "run" ? "off" : "run";
      return;
    }
    if (["KeyW", "KeyS", "ArrowUp", "ArrowDown"].includes(event.code)) {
      this.autoMoveMode = "off";
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
    if (this.traverseMode === "spaceship" && (event.code === "AltLeft" || event.code === "AltRight")) {
      this.shipAimX = 0;
      this.shipAimY = 0;
    }
  };

  private onBlur = () => {
    this.keys.clear();
    this.mouseButtons.clear();
    this.pointerId = null;
    this.shipAimX = 0;
    this.shipAimY = 0;
    this.shipBrakeRequested = false;
    this.shipCruiseThrust = false;
    this.shipLookYawRad = 0;
    this.shipLookPitchRad = 0;
  };

  private onContextMenu = (event: MouseEvent) => {
    if (this.active) event.preventDefault();
  };

  private onPointerDown = (event: PointerEvent) => {
    if (!this.active || (event.button !== 0 && event.button !== 1 && event.button !== 2)) return;
    if (this.traverseMode === "spaceship") {
      event.preventDefault();
      this.canvas.focus({ preventScroll: true });
      this.mouseButtons.add(event.button);
      this.pointerId = event.pointerId;
      this.pointerX = event.clientX;
      this.pointerY = event.clientY;
      this.shipAimX = 0;
      this.shipAimY = 0;
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is only a drag convenience; controls still work without it.
      }
      return;
    }
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
    if (this.active && this.traverseMode === "spaceship") {
      if (this.pointerId === event.pointerId) {
        this.syncMouseButtons(event.buttons);
        const dx = event.clientX - this.pointerX;
        const dy = event.clientY - this.pointerY;
        this.pointerX = event.clientX;
        this.pointerY = event.clientY;
        const cameraOrbiting = (this.mouseButtons.has(0) && !this.mouseButtons.has(2)) ||
          this.mouseButtons.has(1);
        if (cameraOrbiting) {
          const freeLooking = spaceshipAltFreeLook(
            event.altKey || this.keys.has("AltLeft") || this.keys.has("AltRight"),
            this.mouseButtons.has(0),
            this.mouseButtons.has(1),
            this.mouseButtons.has(2),
          );
          const orbit = applySpaceshipCameraOrbitDrag(
            freeLooking ? this.shipLookYawRad : this.shipCameraYawRad,
            freeLooking ? this.shipLookPitchRad : this.shipCameraPitchRad,
            dx,
            dy,
          );
          if (freeLooking) {
            this.shipLookYawRad = orbit.cameraYawRad;
            this.shipLookPitchRad = orbit.cameraPitchRad;
          } else {
            this.shipCameraYawRad = orbit.cameraYawRad;
            this.shipCameraPitchRad = orbit.cameraPitchRad;
          }
          event.preventDefault();
          return;
        }
      }
      this.updateShipAimFromPointer(event.clientX, event.clientY);
      return;
    }
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
    if (this.traverseMode === "spaceship") {
      if (this.pointerId !== event.pointerId) return;
      this.syncMouseButtons(event.buttons);
      if (event.buttons === 0) {
        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        this.pointerId = null;
        this.mouseButtons.clear();
      }
      return;
    }
    if (this.pointerId !== event.pointerId) return;
    this.syncMouseButtons(event.buttons);
    if (event.buttons === 0) {
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.pointerId = null;
      this.mouseButtons.clear();
    }
  };

  private onPointerLeave = () => {
    if (this.traverseMode === "spaceship" && this.pointerId === null) {
      this.shipAimX = 0;
      this.shipAimY = 0;
    }
  };

  private updateShipAimFromPointer(clientX: number, clientY: number) {
    const bounds = this.canvas.getBoundingClientRect();
    this.shipAimX = clamp(
      (clientX - (bounds.left + bounds.width / 2)) / Math.max(1, bounds.width / 2),
      -1,
      1,
    );
    this.shipAimY = clamp(
      ((bounds.top + bounds.height / 2) - clientY) / Math.max(1, bounds.height / 2),
      -1,
      1,
    );
  }

  private syncMouseButtons(buttons: number) {
    if ((buttons & 1) !== 0) this.mouseButtons.add(0);
    else this.mouseButtons.delete(0);
    if ((buttons & 2) !== 0) this.mouseButtons.add(2);
    else this.mouseButtons.delete(2);
    if ((buttons & 4) !== 0) this.mouseButtons.add(1);
    else this.mouseButtons.delete(1);
  }

  private onWheel = (event: WheelEvent) => {
    if (!this.active) return;
    event.preventDefault();
    if (this.traverseMode === "spaceship") {
      const modeScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 480 : 1;
      this.shipCameraDistanceM = applySpaceshipCameraZoom(
        this.shipCameraDistanceM,
        event.deltaY * modeScale,
      );
      return;
    }
    if (this.entryWheelLockSeconds > 0) return;
    const modeScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 480 : 1;
    this.cameraDistanceM = applyWowCameraZoom(this.cameraDistanceM, event.deltaY * modeScale);
  };

  dispose() {
    this.disposed = true;
    this.deactivate();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.mixer?.stopAllAction();
    this.spaceship.dispose();
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
