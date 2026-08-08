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
  SHIP_AUTOPILOT_WARP_SPEED_M_S,
  SHIP_BOARD_DISTANCE_M,
  SurfaceSpaceship,
  spaceshipAutolandDurationS,
  spaceshipDampedInput,
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
const SHIP_CAMERA_BASE_FOV_DEG = 58;
const SHIP_CAMERA_WARP_FOV_DEG = 82;
const SHIP_MOUSE_CAMERA_YAW_RATE_RAD_S = 1.9;
const SHIP_MOUSE_CAMERA_PITCH_RATE_RAD_S = 1.55;
const SHIP_FREE_LOOK_RETURN_RATE_S = 7;
const GROUND_AUTOPILOT_BRAKE_ACCELERATION_M_S2 = 600_000;
const GROUND_AUTOPILOT_STOP_MARGIN_M = 2_000;
const GROUND_AUTOPILOT_LANDING_RANGE_M = 12_000;
const GROUND_AUTOPILOT_LANDING_SPEED_M_S = 80;
const GROUND_AUTOPILOT_ASCENT_SPEED_M_S = 60_000;
const GROUND_AUTOPILOT_MIN_ORBIT_ALTITUDE_M = 180_000;
const GROUND_AUTOPILOT_MAX_ORBIT_ALTITUDE_M = 420_000;
const GROUND_AUTOPILOT_MIN_DEORBIT_RANGE_M = 700_000;
const GROUND_AUTOPILOT_MAX_GLIDE_ALTITUDE_M = 200_000;
const GROUND_AUTOPILOT_MIN_GLIDE_ALTITUDE_M = 850;
const ORBITAL_AUTOPILOT_BRAKE_ACCELERATION_M_S2 = 600_000;

type AnimationName = "idle" | "idle_neutral" | "jump_base" | "walk" | "run" | "jump" | "jump_idle" | "jump_land";
type LocomotionAnimationName = Extract<AnimationName, "walk" | "run">;

// These phases come from the actual astronaut clips: each marker is the frame
// where a boot reaches the ground. Using clip phase keeps the sound attached to
// the pose even when frame rate or animation playback speed changes.
const FOOT_CONTACT_PHASES: Record<LocomotionAnimationName, readonly number[]> = {
  walk: [0.08, 0.58],
  run: [0, 0.5],
};
const SUIT_THRUSTER_DOWN_BIAS = 0.22;
const SUIT_THRUSTER_FOOT_BONE_ALIASES = {
  left: ["Foot.L", "FootL", "LeftFoot", "mixamorigLeftFoot"],
  right: ["Foot.R", "FootR", "RightFoot", "mixamorigRightFoot"],
} as const;

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

/**
 * Returns the boot-plume direction in astronaut-local space. Gameplay strafe
 * right maps to local -X for this model, so the reaction plume maps to +X.
 */
export function suitThrusterLocalDirection(
  forwardInput: number,
  strafeInput: number,
): Vec3 | null {
  const planarMagnitude = Math.hypot(forwardInput, strafeInput);
  if (planarMagnitude <= Number.EPSILON) return null;
  const down = SUIT_THRUSTER_DOWN_BIAS * planarMagnitude;
  const length = Math.hypot(planarMagnitude, down);
  return {
    x: strafeInput / length,
    y: -down / length,
    z: -forwardInput / length,
  };
}

/** Resolves the boot bones across dotted, compact, and Mixamo-style rigs. */
export function findSuitThrusterFootBone<T>(
  bones: ReadonlyMap<string, T>,
  side: keyof typeof SUIT_THRUSTER_FOOT_BONE_ALIASES,
): T | null {
  const aliases = SUIT_THRUSTER_FOOT_BONE_ALIASES[side];
  for (const alias of aliases) {
    const bone = bones.get(alias);
    if (bone) return bone;
  }

  const normalizedAliases = new Set(aliases.map((alias) => alias.replace(/[^a-z0-9]/gi, "").toLowerCase()));
  for (const [name, bone] of bones) {
    if (normalizedAliases.has(name.replace(/[^a-z0-9]/gi, "").toLowerCase())) return bone;
  }
  return null;
}

export function crossedLoopingAnimationPhase(
  previousPhase: number | null,
  currentPhase: number,
  markers: readonly number[],
) {
  const current = ((currentPhase % 1) + 1) % 1;
  if (previousPhase === null) {
    return markers.some((marker) => ((marker % 1) + 1) % 1 <= current);
  }

  const previous = ((previousPhase % 1) + 1) % 1;
  if (current >= previous) {
    return markers.some((marker) => {
      const phase = ((marker % 1) + 1) % 1;
      return phase > previous && phase <= current;
    });
  }
  return markers.some((marker) => {
    const phase = ((marker % 1) + 1) % 1;
    return phase > previous || phase <= current;
  });
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

export type SpaceshipAutoFlightMode = "off" | "cruise" | "full";
export type GroundAutopilotPhase = "idle" | "ascent" | "cruise" | "braking" | "approach" | "landing";
export type FlightAutopilotPhase = GroundAutopilotPhase | "orbit";

export type FlightAutopilotTargetProfile = {
  surfaceTarget: boolean;
  standoffM?: number;
  orbitNormal?: Vec3;
};

export function nextSpaceshipAutoFlightMode(mode: SpaceshipAutoFlightMode): SpaceshipAutoFlightMode {
  if (mode === "off") return "cruise";
  if (mode === "cruise") return "full";
  return "off";
}

export function groundAutopilotStoppingDistanceM(
  speedMps: number,
  decelerationMps2 = GROUND_AUTOPILOT_BRAKE_ACCELERATION_M_S2,
) {
  const speed = Math.max(0, speedMps);
  const deceleration = Math.max(1, decelerationMps2);
  return speed * speed / (2 * deceleration) + GROUND_AUTOPILOT_STOP_MARGIN_M;
}

export function groundAutopilotGlideAltitudeM(surfaceRangeM: number) {
  return clamp(
    Math.max(0, surfaceRangeM) * 0.08,
    GROUND_AUTOPILOT_MIN_GLIDE_ALTITUDE_M,
    GROUND_AUTOPILOT_MAX_GLIDE_ALTITUDE_M,
  );
}

export function groundAutopilotOrbitAltitudeM(surfaceRangeM: number) {
  return clamp(
    150_000 + Math.max(0, surfaceRangeM) * 0.035,
    GROUND_AUTOPILOT_MIN_ORBIT_ALTITUDE_M,
    GROUND_AUTOPILOT_MAX_ORBIT_ALTITUDE_M,
  );
}

export function groundAutopilotCruiseAltitudeM(surfaceRangeM: number, orbitAltitudeM: number) {
  const rangeM = Math.max(0, surfaceRangeM);
  const orbitalAltitudeM = clamp(
    orbitAltitudeM,
    GROUND_AUTOPILOT_MIN_ORBIT_ALTITUDE_M,
    GROUND_AUTOPILOT_MAX_ORBIT_ALTITUDE_M,
  );
  const brakingRangeM = groundAutopilotStoppingDistanceM(SHIP_AUTOPILOT_WARP_SPEED_M_S);
  const deorbitRangeM = Math.max(
    GROUND_AUTOPILOT_MIN_DEORBIT_RANGE_M,
    orbitalAltitudeM * 4,
  );
  const orbitFraction = smoothStep01(clamp(
    (rangeM - brakingRangeM) / Math.max(1, deorbitRangeM - brakingRangeM),
    0,
    1,
  ));
  return THREE.MathUtils.lerp(
    groundAutopilotGlideAltitudeM(brakingRangeM),
    orbitalAltitudeM,
    orbitFraction,
  );
}

export function orbitalAutopilotStandoffM(kind: "moon" | "orbiter", maximumRadiusM: number) {
  const radiusM = Math.max(0.5, maximumRadiusM);
  // Moons should nearly fill the 58-degree chase view. Spacecraft need extra
  // room for the chase camera and their long solar arrays.
  return kind === "moon"
    ? radiusM * 2.35
    : Math.max(12, radiusM * 3.2);
}

export function orbitalAutopilotStoppingDistanceM(relativeSpeedMps: number, standoffM: number) {
  const speedMps = Math.max(0, relativeSpeedMps);
  return speedMps * speedMps / (2 * ORBITAL_AUTOPILOT_BRAKE_ACCELERATION_M_S2) +
    Math.max(250, Math.max(0, standoffM) * 0.5);
}

export function nextOrbitalAutopilotPhase(
  phase: FlightAutopilotPhase,
  centerDistanceM: number,
  relativeSpeedMps: number,
  standoffM: number,
): FlightAutopilotPhase {
  const remainingM = Math.max(0, centerDistanceM - Math.max(0, standoffM));
  if (phase === "cruise" && remainingM <= orbitalAutopilotStoppingDistanceM(relativeSpeedMps, standoffM)) {
    return "braking";
  }
  if (phase === "braking" && remainingM <= Math.max(2_500, standoffM * 0.75)) return "approach";
  if (
    phase === "approach" &&
    remainingM <= Math.max(2, standoffM * 0.025) &&
    relativeSpeedMps <= Math.max(12, Math.min(180, standoffM * 0.012))
  ) {
    return "orbit";
  }
  return phase;
}

export function nextGroundAutopilotPhase(
  phase: GroundAutopilotPhase,
  surfaceRangeM: number,
  speedMps: number,
  altitudeM = 0,
  orbitAltitudeM = GROUND_AUTOPILOT_MIN_ORBIT_ALTITUDE_M,
): GroundAutopilotPhase {
  const range = Math.max(0, surfaceRangeM);
  const speed = Math.max(0, speedMps);
  if (phase === "ascent") {
    return altitudeM >= Math.max(1, orbitAltitudeM) * 0.97 ? "cruise" : "ascent";
  }
  if (phase === "cruise" && range <= groundAutopilotStoppingDistanceM(speed)) return "braking";
  if (phase === "braking" && speed <= GROUND_AUTOPILOT_LANDING_SPEED_M_S) {
    // Braking normally ends about 2 km from the target. If a coarse frame or
    // unusual route leaves us farther out, re-enter orbital ascent instead of
    // crawling indefinitely near the terrain.
    return range <= GROUND_AUTOPILOT_LANDING_RANGE_M ? "landing" : "ascent";
  }
  if (phase === "approach") {
    if (range <= GROUND_AUTOPILOT_LANDING_RANGE_M && speed <= GROUND_AUTOPILOT_LANDING_SPEED_M_S) {
      return "landing";
    }
    if (range > GROUND_AUTOPILOT_LANDING_RANGE_M && speed <= GROUND_AUTOPILOT_LANDING_SPEED_M_S) {
      return "ascent";
    }
    if (speed > GROUND_AUTOPILOT_LANDING_SPEED_M_S * 1.5) return "braking";
  }
  return phase;
}

export function groundAutopilotEtaSeconds(
  phase: FlightAutopilotPhase,
  surfaceRangeM: number,
  speedMps: number,
  verticalDistanceM: number,
  autolandRemainingSeconds: number | null = null,
  orbitAltitudeM = groundAutopilotOrbitAltitudeM(surfaceRangeM),
) {
  if (phase === "idle" || phase === "orbit") return null;
  if (phase === "landing" && autolandRemainingSeconds !== null) {
    return Math.max(0, autolandRemainingSeconds);
  }
  const rangeM = Math.max(0, surfaceRangeM);
  const speed = Math.max(0, speedMps);
  const predictedLandingRangeM = phase === "ascent" || phase === "cruise"
    ? Math.min(rangeM, GROUND_AUTOPILOT_STOP_MARGIN_M)
    : phase === "braking"
      ? Math.min(
        rangeM,
        GROUND_AUTOPILOT_LANDING_RANGE_M,
        Math.abs(rangeM - speed * speed / (2 * GROUND_AUTOPILOT_BRAKE_ACCELERATION_M_S2)),
      )
      : Math.min(rangeM, GROUND_AUTOPILOT_LANDING_RANGE_M);
  const predictedLandingVerticalM = phase === "ascent" || phase === "cruise" || phase === "braking"
    ? Math.min(Math.max(0, verticalDistanceM), groundAutopilotGlideAltitudeM(predictedLandingRangeM))
    : Math.max(0, verticalDistanceM);
  const descentSeconds = spaceshipAutolandDurationS(
    predictedLandingRangeM,
    predictedLandingVerticalM,
  );
  if (phase === "ascent") {
    return Math.max(0, orbitAltitudeM - Math.max(0, verticalDistanceM)) /
      GROUND_AUTOPILOT_ASCENT_SPEED_M_S +
      Math.max(0, rangeM - groundAutopilotStoppingDistanceM(SHIP_AUTOPILOT_WARP_SPEED_M_S)) /
        SHIP_AUTOPILOT_WARP_SPEED_M_S +
      SHIP_AUTOPILOT_WARP_SPEED_M_S / GROUND_AUTOPILOT_BRAKE_ACCELERATION_M_S2 +
      descentSeconds;
  }
  if (phase === "cruise") {
    const brakingDistanceM = groundAutopilotStoppingDistanceM(
      Math.max(speed, SHIP_AUTOPILOT_WARP_SPEED_M_S),
    );
    return Math.max(0, rangeM - brakingDistanceM) / SHIP_AUTOPILOT_WARP_SPEED_M_S +
      SHIP_AUTOPILOT_WARP_SPEED_M_S / GROUND_AUTOPILOT_BRAKE_ACCELERATION_M_S2 +
      descentSeconds;
  }
  if (phase === "braking") {
    return speed / GROUND_AUTOPILOT_BRAKE_ACCELERATION_M_S2 + descentSeconds;
  }
  return descentSeconds;
}

const SPACESHIP_MANUAL_CONTROL_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyZ", "KeyC", "KeyX", "KeyF",
  "Space", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

export function isSpaceshipManualFlightControlKey(code: string) {
  return SPACESHIP_MANUAL_CONTROL_KEYS.has(code);
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

export function spaceshipKeyboardAttitudeInput(keys: ReadonlySet<string>) {
  return {
    strafe: Number(keys.has("KeyC")) - Number(keys.has("KeyZ")),
    lift: Number(keys.has("Space")) - Number(keys.has("ControlLeft") || keys.has("ControlRight")),
    // Heading belongs to the camera aim. Flat A/D or arrow-key yaw made the
    // craft swivel laterally without first pointing its nose at the turn.
    yaw: 0,
    pitch: Number(keys.has("ArrowUp")) - Number(keys.has("ArrowDown")),
    roll: Number(keys.has("KeyE")) - Number(keys.has("KeyQ")),
    boost: keys.has("ShiftLeft") || keys.has("ShiftRight"),
  };
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
  private readonly shipAutopilotTargetAbsolute = new THREE.Vector3();
  private readonly shipAutopilotTargetDirection = new THREE.Vector3();
  private readonly shipAutopilotTangent = new THREE.Vector3();
  private readonly shipAutopilotAimDirection = new THREE.Vector3();
  private readonly shipAutopilotPreviousTargetAbsolute = new THREE.Vector3();
  private readonly shipAutopilotTargetVelocity = new THREE.Vector3();
  private readonly shipAutopilotMeasuredTargetVelocity = new THREE.Vector3();
  private readonly shipAutopilotPreviousMeasuredTargetVelocity = new THREE.Vector3();
  private readonly shipAutopilotShipVelocity = new THREE.Vector3();
  private readonly shipAutopilotRelativeVelocity = new THREE.Vector3();
  private readonly shipAutopilotVelocityTarget = new THREE.Vector3();
  private readonly shipAutopilotOrbitAxis = new THREE.Vector3(0, 1, 0);
  private readonly shipAutopilotOrbitDirection = new THREE.Vector3(1, 0, 0);
  private readonly shipAutopilotOrbitPosition = new THREE.Vector3();
  private readonly shipAutopilotPositionError = new THREE.Vector3();
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
  private readonly suitThrusterDirectionLocal = new THREE.Vector3();
  private readonly suitThrusterSourceAxis = new THREE.Vector3(0, -1, 0);
  private readonly suitThrusterPlumes: THREE.Group[] = [];
  private readonly suitThrusterFootBones: Array<THREE.Bone | null> = [null, null];
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
  private footstepAnimation: LocomotionAnimationName | null = null;
  private footstepPhase: number | null = null;
  private suitThrusterActive = false;
  private suitThrusterTimeSeconds = 0;
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
  private shipAutoFlightMode: SpaceshipAutoFlightMode = "off";
  private shipAutopilotTargetActive = false;
  private shipAutopilotSurfaceTarget = false;
  private shipAutopilotOrbitAltitudeM = GROUND_AUTOPILOT_MIN_ORBIT_ALTITUDE_M;
  private shipAutopilotStandoffM = 0;
  private shipAutopilotHasVelocitySample = false;
  private shipAutopilotPhase: FlightAutopilotPhase = "idle";
  private shipWarpBurstRequested = false;
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
    this.suitThrusterPlumes.push(
      this.createSuitThrusterPlume("Left boot maneuvering thruster"),
      this.createSuitThrusterPlume("Right boot maneuvering thruster"),
    );
    this.root.add(...this.suitThrusterPlumes);
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
      this.suitThrusterFootBones[0] = findSuitThrusterFootBone(this.poseBones, "left");
      this.suitThrusterFootBones[1] = findSuitThrusterFootBone(this.poseBones, "right");
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

  private createSuitThrusterPlume(name: string) {
    const plume = new THREE.Group();
    plume.name = name;
    plume.visible = false;

    const outerGeometry = new THREE.ConeGeometry(0.075, 0.52, 10, 1, true);
    outerGeometry.translate(0, -0.26, 0);
    const outer = new THREE.Mesh(
      outerGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x39bfff,
        transparent: true,
        opacity: 0.44,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      }),
    );

    const coreGeometry = new THREE.ConeGeometry(0.038, 0.34, 8, 1, true);
    coreGeometry.translate(0, -0.17, 0);
    const core = new THREE.Mesh(
      coreGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xd9fbff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      }),
    );

    const nozzleGeometry = new THREE.TorusGeometry(0.054, 0.011, 6, 14);
    nozzleGeometry.rotateX(Math.PI / 2);
    const nozzleGlow = new THREE.Mesh(
      nozzleGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x8beaff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    const light = new THREE.PointLight(0x5ed8ff, 1.4, 1.6, 2);
    light.position.y = -0.04;
    for (const mesh of [outer, core, nozzleGlow]) {
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
    }
    plume.add(outer, core, nozzleGlow, light);
    return plume;
  }

  teleportRandom(random: () => number = Math.random) {
    this.teleportTo(randomMarsSurfaceDirection(random), random() * Math.PI * 2);
  }

  teleportTo(targetDirection: Vec3, headingRad = Math.random() * Math.PI * 2) {
    const wasActive = this.active;
    this.setSuitThrusterActive(false);
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
    this.resetFootstepSync();
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
    this.shipAutoFlightMode = "off";
    this.shipAutopilotTargetActive = false;
    this.shipAutopilotPhase = "idle";
    this.shipWarpBurstRequested = false;
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
    this.setSuitThrusterActive(false);
    this.active = false;
    this.root.visible = false;
    this.localFill.visible = false;
    this.spaceship.deactivate();
    this.onAudioEvent({ type: "flight", active: false, throttle: 0, boost: false, maneuver: 0 });
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
    let autopilotEtaSeconds: number | null = null;
    if (
      this.traverseMode === "spaceship" &&
      this.shipAutopilotTargetActive &&
      this.shipAutopilotSurfaceTarget
    ) {
      this.spaceship.getAbsolute(this.shipAbsolute);
      this.shipRadialUp.copy(this.shipAbsolute).normalize();
      this.shipAutopilotTargetDirection.copy(this.shipAutopilotTargetAbsolute).normalize();
      const surfaceRangeM = Math.acos(clamp(
        this.shipRadialUp.dot(this.shipAutopilotTargetDirection),
        -1,
        1,
      )) * MARS_REFERENCE_RADIUS_M;
      autopilotEtaSeconds = groundAutopilotEtaSeconds(
        this.shipAutopilotPhase,
        surfaceRangeM,
        this.spaceship.getSpeedMps(),
        Math.abs(this.shipAbsolute.length() - this.shipAutopilotTargetAbsolute.length()),
        this.spaceship.getAutolandRemainingSeconds(),
        this.shipAutopilotOrbitAltitudeM,
      );
    }
    return {
      distanceM: this.shipDistanceM,
      canBoard: this.shipCanBoard,
      speedMps: this.traverseMode === "spaceship" ? this.spaceship.getSpeedMps() : 0,
      autoFlightMode: this.traverseMode === "spaceship" ? this.shipAutoFlightMode : "off",
      autopilotPhase: this.traverseMode === "spaceship" ? this.shipAutopilotPhase : "idle",
      autopilotEtaSeconds,
    };
  }

  get destinationAutopilotActive() {
    return this.traverseMode === "spaceship" &&
      this.shipAutopilotTargetActive &&
      this.shipAutoFlightMode !== "off";
  }

  engageFlightAutopilot(
    targetPositionM: Vec3,
    targetProfile: boolean | FlightAutopilotTargetProfile,
  ) {
    if (!this.active || this.traverseMode !== "spaceship") return false;
    this.shipAutopilotTargetAbsolute.set(targetPositionM.x, targetPositionM.y, targetPositionM.z);
    if (this.shipAutopilotTargetAbsolute.lengthSq() <= 1e-8) return false;
    this.spaceship.getAbsolute(this.shipAbsolute);
    const profile = typeof targetProfile === "boolean"
      ? { surfaceTarget: targetProfile }
      : targetProfile;
    this.shipAutopilotSurfaceTarget = profile.surfaceTarget;
    this.shipAutopilotStandoffM = profile.surfaceTarget ? 0 : Math.max(2, profile.standoffM ?? 40);
    this.shipRadialUp.copy(this.shipAbsolute).normalize();
    this.shipAutopilotTargetDirection.copy(this.shipAutopilotTargetAbsolute).normalize();
    const initialSurfaceRangeM = Math.acos(clamp(
      this.shipRadialUp.dot(this.shipAutopilotTargetDirection),
      -1,
      1,
    )) * MARS_REFERENCE_RADIUS_M;
    this.shipAutopilotOrbitAltitudeM = profile.surfaceTarget
      ? groundAutopilotOrbitAltitudeM(initialSurfaceRangeM)
      : GROUND_AUTOPILOT_MIN_ORBIT_ALTITUDE_M;
    this.shipAutopilotPreviousTargetAbsolute.copy(this.shipAutopilotTargetAbsolute);
    this.shipAutopilotTargetVelocity.set(0, 0, 0);
    this.shipAutopilotPreviousMeasuredTargetVelocity.set(0, 0, 0);
    this.shipAutopilotHasVelocitySample = false;
    if (profile.orbitNormal) {
      this.shipAutopilotOrbitAxis.set(
        profile.orbitNormal.x,
        profile.orbitNormal.y,
        profile.orbitNormal.z,
      );
      if (this.shipAutopilotOrbitAxis.lengthSq() > 1e-8) this.shipAutopilotOrbitAxis.normalize();
    }
    this.shipAutopilotTargetActive = true;
    this.shipAutopilotPhase = profile.surfaceTarget ? "ascent" : "cruise";
    this.shipAutoFlightMode = "full";
    this.shipBrakeRequested = false;
    return true;
  }

  updateFlightAutopilotTarget(targetPositionM: Vec3, deltaSeconds = 0, orbitNormal?: Vec3) {
    if (!this.destinationAutopilotActive) return;
    if (!this.shipAutopilotSurfaceTarget && deltaSeconds > 0) {
      this.shipAutopilotMeasuredTargetVelocity
        .set(targetPositionM.x, targetPositionM.y, targetPositionM.z)
        .sub(this.shipAutopilotPreviousTargetAbsolute)
        .multiplyScalar(1 / deltaSeconds);
      // A backward difference represents velocity halfway through the prior
      // frame. Extrapolating half a sample keeps 60x orbiters locked instead
      // of leaving the ship one fast-moving frame behind them.
      this.shipAutopilotTargetVelocity.copy(this.shipAutopilotMeasuredTargetVelocity);
      if (this.shipAutopilotHasVelocitySample) {
        this.shipAutopilotTargetVelocity
          .multiplyScalar(1.5)
          .addScaledVector(this.shipAutopilotPreviousMeasuredTargetVelocity, -0.5);
      }
      this.shipAutopilotPreviousMeasuredTargetVelocity.copy(
        this.shipAutopilotMeasuredTargetVelocity,
      );
      this.shipAutopilotHasVelocitySample = true;
    }
    this.shipAutopilotTargetAbsolute.set(targetPositionM.x, targetPositionM.y, targetPositionM.z);
    this.shipAutopilotPreviousTargetAbsolute.copy(this.shipAutopilotTargetAbsolute);
    if (orbitNormal) {
      this.shipAutopilotOrbitAxis.set(orbitNormal.x, orbitNormal.y, orbitNormal.z);
      if (this.shipAutopilotOrbitAxis.lengthSq() > 1e-8) this.shipAutopilotOrbitAxis.normalize();
    }
  }

  private cancelSpaceshipAutomation() {
    this.shipAutoFlightMode = "off";
    this.shipAutopilotTargetActive = false;
    this.shipAutopilotPhase = "idle";
    this.shipAutopilotTargetVelocity.set(0, 0, 0);
    this.shipAutopilotHasVelocitySample = false;
    this.spaceship.cancelAutoland();
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
      this.resetFootstepSync();
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

  private resetFootstepSync() {
    this.footstepAnimation = null;
    this.footstepPhase = null;
  }

  private updateFootsteps(speedMps: number, airborne: boolean) {
    if (airborne || this.landingSeconds > 0 || speedMps <= 0) {
      this.resetFootstepSync();
      return;
    }

    const running = speedMps >= RUN_SPEED_M_S - 0.1;
    const animation: LocomotionAnimationName = running ? "run" : "walk";
    const action = this.actions.get(animation) ?? (animation === "run" ? this.actions.get("walk") : undefined);
    const duration = action?.getClip().duration ?? 0;
    if (!action || action !== this.currentAction || duration <= 0) {
      this.resetFootstepSync();
      return;
    }

    const phase = action.time / duration;
    const previousPhase = this.footstepAnimation === animation ? this.footstepPhase : null;
    if (crossedLoopingAnimationPhase(previousPhase, phase, FOOT_CONTACT_PHASES[animation])) {
      this.onAudioEvent({ type: "step", running });
    }
    this.footstepAnimation = animation;
    this.footstepPhase = phase;
  }

  private setSuitThrusterActive(active: boolean) {
    if (active === this.suitThrusterActive) return;
    this.suitThrusterActive = active;
    if (!active) {
      for (const plume of this.suitThrusterPlumes) plume.visible = false;
    }
    this.onAudioEvent({ type: "suitThruster", active });
  }

  private updateSuitThrusters(airborne: boolean, deltaSeconds: number) {
    const forwardInput = Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"));
    const strafeInput = wowStrafeInput(this.keys.has("KeyQ"), this.keys.has("KeyE"));
    const direction = suitThrusterLocalDirection(forwardInput, strafeInput);
    const active = airborne && direction !== null;
    this.setSuitThrusterActive(active);
    if (!active || !direction) return;

    this.suitThrusterTimeSeconds += deltaSeconds;
    this.suitThrusterDirectionLocal.set(direction.x, direction.y, direction.z);
    this.model?.updateWorldMatrix(true, true);
    for (let index = 0; index < this.suitThrusterPlumes.length; index += 1) {
      const plume = this.suitThrusterPlumes[index];
      const foot = this.suitThrusterFootBones[index];
      plume.visible = Boolean(foot);
      if (!foot) continue;

      foot.getWorldPosition(this.poseFoot);
      this.root.worldToLocal(this.poseFoot);
      plume.position.copy(this.poseFoot)
        .addScaledVector(this.suitThrusterDirectionLocal, 0.055);
      plume.position.y -= 0.045;
      plume.quaternion.setFromUnitVectors(
        this.suitThrusterSourceAxis,
        this.suitThrusterDirectionLocal,
      );
      const pulse = Math.sin(this.suitThrusterTimeSeconds * 34 + index * 1.7);
      const radialScale = 0.92 + pulse * 0.1;
      plume.scale.set(radialScale, 0.92 + pulse * 0.14, radialScale);
    }
  }

  private playAnimation(name: AnimationName, fadeSeconds = 0.16) {
    if (name !== "walk" && name !== "run") this.resetFootstepSync();
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
    this.setSuitThrusterActive(false);
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
    this.shipAutoFlightMode = "off";
    this.shipAutopilotTargetActive = false;
    this.shipAutopilotPhase = "idle";
    this.shipWarpBurstRequested = false;
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
    this.camera.fov = SHIP_CAMERA_BASE_FOV_DEG;
    this.camera.updateProjectionMatrix();
  }

  private returnToSpacemanAtGround(groundDirection: THREE.Vector3) {
    this.onAudioEvent({ type: "flight", active: false, throttle: 0, boost: false, maneuver: 0 });
    this.spaceship.getForward(this.shipForward);
    this.direction.copy(groundDirection).normalize();
    const surface = this.terrainSurface(this.direction);
    this.groundHeightM = surface.heightM;
    this.verticalOffsetM = 0;
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
    this.cameraYawRad = this.headingRad;
    this.cameraPitchRad = CAMERA_INITIAL_LOOK_PITCH_RAD;
    this.cameraDistanceM = CAMERA_DEFAULT_DISTANCE_M;
    this.cameraAnchorInitialized = false;
    this.cameraCollisionFraction = 1;
    this.entryWheelLockSeconds = 0;
    this.headingVector(this.headingRad, this.forward);
    const spawnRight = surfaceCameraRight(this.forward, this.up);
    this.right.set(spawnRight.x, spawnRight.y, spawnRight.z);
    this.spaceship.spawnNear(this.direction, this.forward, this.right);
    const groundRadiusM = MARS_REFERENCE_RADIUS_M + this.groundHeightM;
    this.playerAbsolute.copy(this.direction).multiplyScalar(
      groundRadiusM + BOOT_SOLE_CLEARANCE_M,
    );
    this.traverseMode = "spaceman";
    this.shipDistanceM = this.spaceship.distanceTo(this.playerAbsolute);
    this.shipCanBoard = this.shipDistanceM <= SHIP_BOARD_DISTANCE_M;
    this.shipAimX = 0;
    this.shipAimY = 0;
    this.shipBrakeRequested = false;
    this.shipAutoFlightMode = "off";
    this.shipAutopilotTargetActive = false;
    this.shipAutopilotPhase = "idle";
    this.shipWarpBurstRequested = false;
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
    this.playAnimation("idle");
    return true;
  }

  disembarkSpaceship() {
    if (!this.active || this.traverseMode !== "spaceship") return false;
    this.spaceship.getAbsolute(this.shipAbsolute);
    return this.returnToSpacemanAtGround(this.shipAbsolute.normalize());
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

  private resolveSpaceshipAimDirection(deltaSeconds: number) {
    if (!this.shipAutopilotTargetActive) return this.shipCameraForward;
    this.spaceship.getAbsolute(this.shipAbsolute);
    if (!this.shipAutopilotSurfaceTarget) {
      this.shipAutopilotAimDirection
        .copy(this.shipAutopilotTargetAbsolute)
        .sub(this.shipAbsolute);
      const centerDistanceM = this.shipAutopilotAimDirection.length();
      if (centerDistanceM <= 1e-4) return this.shipCameraForward;
      this.shipAutopilotAimDirection.multiplyScalar(1 / centerDistanceM);

      if (this.shipAutopilotPhase !== "orbit") {
        const remainingM = Math.max(0, centerDistanceM - this.shipAutopilotStandoffM);
        const relativeClosingSpeedMps = this.shipAutopilotPhase === "cruise"
          ? SHIP_AUTOPILOT_WARP_SPEED_M_S
          : this.shipAutopilotPhase === "braking"
            ? Math.min(
              SHIP_AUTOPILOT_WARP_SPEED_M_S,
              Math.sqrt(2 * ORBITAL_AUTOPILOT_BRAKE_ACCELERATION_M_S2 * remainingM),
            )
            : Math.min(1_200, remainingM * 0.35);
        this.shipAutopilotVelocityTarget
          .copy(this.shipAutopilotTargetVelocity)
          .addScaledVector(this.shipAutopilotAimDirection, relativeClosingSpeedMps);
        return this.shipAutopilotAimDirection;
      }

      this.shipAutopilotOrbitDirection.applyAxisAngle(
        this.shipAutopilotOrbitAxis,
        clamp(12 / this.shipAutopilotStandoffM, 0.003, 0.08) * Math.max(0, deltaSeconds),
      ).normalize();
      this.shipAutopilotTangent.crossVectors(
        this.shipAutopilotOrbitAxis,
        this.shipAutopilotOrbitDirection,
      );
      if (this.shipAutopilotTangent.lengthSq() <= 1e-8) {
        this.shipAutopilotTangent.crossVectors(this.shipRadialUp, this.shipAutopilotOrbitDirection);
      }
      this.shipAutopilotTangent.normalize();
      this.shipAutopilotOrbitPosition
        .copy(this.shipAutopilotTargetAbsolute)
        .addScaledVector(this.shipAutopilotOrbitDirection, this.shipAutopilotStandoffM);
      this.shipAutopilotPositionError
        .copy(this.shipAutopilotOrbitPosition)
        .sub(this.shipAbsolute)
        .multiplyScalar(0.72);
      const maximumCorrectionMps = Math.max(6, Math.min(2_500, this.shipAutopilotStandoffM * 0.18));
      if (this.shipAutopilotPositionError.length() > maximumCorrectionMps) {
        this.shipAutopilotPositionError.setLength(maximumCorrectionMps);
      }
      const orbitSpeedMps = clamp(this.shipAutopilotStandoffM * 0.003, 1.2, 120);
      this.shipAutopilotVelocityTarget
        .copy(this.shipAutopilotTargetVelocity)
        .addScaledVector(this.shipAutopilotTangent, orbitSpeedMps)
        .add(this.shipAutopilotPositionError);
      // The hull and chase camera keep looking inward while the velocity
      // computer carries the ship gently around the moving target.
      return this.shipAutopilotAimDirection;
    }

    this.shipRadialUp.copy(this.shipAbsolute).normalize();
    this.shipAutopilotTargetDirection.copy(this.shipAutopilotTargetAbsolute).normalize();
    const targetDot = clamp(this.shipRadialUp.dot(this.shipAutopilotTargetDirection), -1, 1);
    const angularDistanceRad = Math.acos(targetDot);
    const surfaceRangeM = angularDistanceRad * MARS_REFERENCE_RADIUS_M;
    this.shipAutopilotTangent
      .copy(this.shipAutopilotTargetDirection)
      .addScaledVector(this.shipRadialUp, -targetDot);
    if (this.shipAutopilotTangent.lengthSq() <= 1e-8) {
      this.spaceship.getForward(this.shipAutopilotTangent)
        .addScaledVector(this.shipRadialUp, -this.shipAutopilotTangent.dot(this.shipRadialUp));
    }
    if (this.shipAutopilotTangent.lengthSq() <= 1e-8) return this.shipCameraForward;
    this.shipAutopilotTangent.normalize();

    if (this.shipAutopilotPhase === "ascent") {
      const currentSurface = this.terrainSurface(this.shipRadialUp);
      const altitudeM = Math.max(
        0,
        this.shipAbsolute.length() - MARS_REFERENCE_RADIUS_M - currentSurface.heightM,
      );
      const ascentProgress = clamp(
        altitudeM / Math.max(1, this.shipAutopilotOrbitAltitudeM),
        0,
        1,
      );
      // Climb nearly vertically through the atmosphere, then roll smoothly
      // onto the great-circle tangent for orbital insertion near apogee.
      const insertion = smoothStep01(clamp((ascentProgress - 0.78) / 0.22, 0, 1));
      return this.shipAutopilotAimDirection
        .copy(this.shipRadialUp)
        .multiplyScalar(1 - insertion)
        .addScaledVector(this.shipAutopilotTangent, insertion)
        .normalize();
    }

    const cruiseAltitudeM = this.shipAutopilotPhase === "cruise" ||
      this.shipAutopilotPhase === "braking"
      ? groundAutopilotCruiseAltitudeM(surfaceRangeM, this.shipAutopilotOrbitAltitudeM)
      : groundAutopilotGlideAltitudeM(surfaceRangeM);
    const cruiseRadiusM = this.shipAutopilotTargetAbsolute.length() + cruiseAltitudeM;
    if (angularDistanceRad <= 0.001) {
      this.shipAutopilotAimDirection
        .copy(this.shipAutopilotTargetDirection)
        .multiplyScalar(cruiseRadiusM)
        .sub(this.shipAbsolute);
      if (this.shipAutopilotAimDirection.lengthSq() > 1e-8) {
        return this.shipAutopilotAimDirection.normalize();
      }
      return this.shipCameraForward;
    }

    const radialCorrection = clamp(
      (cruiseRadiusM - this.shipAbsolute.length()) / 25_000,
      -0.42,
      0.42,
    );
    return this.shipAutopilotAimDirection
      .copy(this.shipAutopilotTangent)
      .addScaledVector(this.shipRadialUp, radialCorrection)
      .normalize();
  }

  private updateDestinationAutopilotPhase() {
    if (!this.shipAutopilotTargetActive || this.shipAutopilotPhase === "landing") return;
    this.spaceship.getAbsolute(this.shipAbsolute);
    if (!this.shipAutopilotSurfaceTarget) {
      this.spaceship.getVelocity(this.shipAutopilotShipVelocity);
      this.shipAutopilotRelativeVelocity
        .copy(this.shipAutopilotShipVelocity)
        .sub(this.shipAutopilotTargetVelocity);
      const centerDistanceM = this.shipAutopilotTargetAbsolute.distanceTo(this.shipAbsolute);
      const nextPhase = nextOrbitalAutopilotPhase(
        this.shipAutopilotPhase,
        centerDistanceM,
        this.shipAutopilotRelativeVelocity.length(),
        this.shipAutopilotStandoffM,
      );
      if (nextPhase === "orbit" && this.shipAutopilotPhase !== "orbit") {
        this.shipAutopilotOrbitDirection
          .copy(this.shipAbsolute)
          .sub(this.shipAutopilotTargetAbsolute)
          .addScaledVector(
            this.shipAutopilotOrbitAxis,
            -this.shipAutopilotOrbitDirection.dot(this.shipAutopilotOrbitAxis),
          );
        if (this.shipAutopilotOrbitDirection.lengthSq() <= 1e-8) {
          this.shipAutopilotOrbitDirection.crossVectors(
            this.shipAutopilotOrbitAxis,
            this.shipAutopilotAimDirection,
          );
        }
        if (this.shipAutopilotOrbitDirection.lengthSq() <= 1e-8) {
          this.shipAutopilotOrbitDirection.set(1, 0, 0)
            .addScaledVector(
              this.shipAutopilotOrbitAxis,
              -this.shipAutopilotOrbitAxis.x,
            );
        }
        this.shipAutopilotOrbitDirection.normalize();
      }
      this.shipAutopilotPhase = nextPhase;
      return;
    }
    if (this.shipAutopilotPhase === "orbit") return;
    this.shipRadialUp.copy(this.shipAbsolute).normalize();
    this.shipAutopilotTargetDirection.copy(this.shipAutopilotTargetAbsolute).normalize();
    const surfaceRangeM = Math.acos(clamp(
      this.shipRadialUp.dot(this.shipAutopilotTargetDirection),
      -1,
      1,
    )) * MARS_REFERENCE_RADIUS_M;
    const currentSurface = this.terrainSurface(this.shipRadialUp);
    const altitudeM = Math.max(
      0,
      this.shipAbsolute.length() - MARS_REFERENCE_RADIUS_M - currentSurface.heightM,
    );
    const nextPhase = nextGroundAutopilotPhase(
      this.shipAutopilotPhase,
      surfaceRangeM,
      this.shipAutopilotPhase === "cruise"
        ? Math.max(this.spaceship.getSpeedMps(), SHIP_AUTOPILOT_WARP_SPEED_M_S)
        : this.spaceship.getSpeedMps(),
      altitudeM,
      this.shipAutopilotOrbitAltitudeM,
    );
    if (nextPhase === "landing") {
      if (this.spaceship.beginAutoland(this.shipAutopilotTargetAbsolute)) {
        this.shipAutopilotPhase = "landing";
      } else {
        this.shipAutopilotPhase = "approach";
      }
      return;
    }
    this.shipAutopilotPhase = nextPhase;
  }

  private updateSpaceship(delta: number, elapsedDelta = delta): PlanetControlState {
    const manualStopRequested = this.keys.has("KeyS") || this.keys.has("ArrowDown");
    const holdRequested = this.shipBrakeRequested || this.keys.has("KeyX");
    this.shipBrakeRequested = false;
    const warpBurst = this.shipWarpBurstRequested;
    this.shipWarpBurstRequested = false;
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
    this.updateDestinationAutopilotPhase();
    if (this.shipAutopilotPhase === "landing") {
      this.onAudioEvent({ type: "flight", active: true, throttle: 0.32, boost: false, maneuver: 0 });
      const landed = this.spaceship.updateAutoland(elapsedDelta);
      if (landed) {
        this.shipAutopilotTargetDirection.copy(this.shipAutopilotTargetAbsolute).normalize();
        this.returnToSpacemanAtGround(this.shipAutopilotTargetDirection);
        return this.update(0);
      }
    }
    const keyboardAttitude = spaceshipKeyboardAttitudeInput(this.keys);
    const groundAutopilotActive = this.shipAutopilotTargetActive && this.shipAutopilotSurfaceTarget;
    const orbitalAutopilotActive = this.shipAutopilotTargetActive && !this.shipAutopilotSurfaceTarget;
    const surfaceAscentActive = groundAutopilotActive && this.shipAutopilotPhase === "ascent";
    const destinationWarpCruise = this.shipAutopilotTargetActive &&
      this.shipAutopilotPhase === "cruise";
    const automatedApproach = this.shipAutopilotTargetActive &&
      this.shipAutopilotPhase !== "cruise";
    const speedMps = this.spaceship.getSpeedMps();
    let autopilotThrottle = this.shipAutoFlightMode === "off" || orbitalAutopilotActive ? 0 : 1;
    let autopilotBrakeAccelerationMps2 = 0;
    if (groundAutopilotActive && this.shipAutopilotPhase === "braking") {
      autopilotThrottle = 0;
      autopilotBrakeAccelerationMps2 = GROUND_AUTOPILOT_BRAKE_ACCELERATION_M_S2;
    } else if (groundAutopilotActive && this.shipAutopilotPhase === "approach") {
      autopilotThrottle = speedMps < 55 ? 0.12 : 0;
      if (speedMps > GROUND_AUTOPILOT_LANDING_SPEED_M_S) {
        autopilotBrakeAccelerationMps2 = 8_000;
      }
    }
    const aimDirection = this.resolveSpaceshipAimDirection(delta);
    const brakeAccelerationMps2 = manualStopRequested
      ? clamp(speedMps * 2.2, 40, 90_000)
      : autopilotBrakeAccelerationMps2;
    const brakeRequested = manualStopRequested || holdRequested || brakeAccelerationMps2 > 0;
    const flightInput: SpaceshipFlightInput = {
      throttle: clamp(
        autopilotThrottle + Number(this.keys.has("KeyW") || mouseForward),
        0,
        1,
      ),
      ...keyboardAttitude,
      boost: keyboardAttitude.boost || surfaceAscentActive ||
        (this.shipAutoFlightMode === "full" && !automatedApproach),
      brake: brakeRequested,
      brakeAccelerationMps2,
      aimX: 0,
      aimY: 0,
      aimDirection: {
        x: aimDirection.x,
        y: aimDirection.y,
        z: aimDirection.z,
      },
      velocityAssistDirection: groundAutopilotActive ? {
        x: aimDirection.x,
        y: aimDirection.y,
        z: aimDirection.z,
      } : undefined,
      velocityAssistRateS: groundAutopilotActive
        ? this.shipAutopilotPhase === "cruise" ? 0.9 : surfaceAscentActive ? 5 : 1.8
        : 0,
      velocityTargetMps: orbitalAutopilotActive ? {
        x: this.shipAutopilotVelocityTarget.x,
        y: this.shipAutopilotVelocityTarget.y,
        z: this.shipAutopilotVelocityTarget.z,
      } : surfaceAscentActive ? {
        x: aimDirection.x * GROUND_AUTOPILOT_ASCENT_SPEED_M_S,
        y: aimDirection.y * GROUND_AUTOPILOT_ASCENT_SPEED_M_S,
        z: aimDirection.z * GROUND_AUTOPILOT_ASCENT_SPEED_M_S,
      } : undefined,
      velocityTargetResponseS: orbitalAutopilotActive
        ? this.shipAutopilotPhase === "orbit" ? 14 : 22
        : surfaceAscentActive ? 18 : 0,
      warpBurst,
      sustainedWarp: destinationWarpCruise,
    };
    this.onAudioEvent({
      type: "flight",
      active: true,
      throttle: brakeRequested ? 0 : flightInput.throttle,
      boost: flightInput.boost || warpBurst || destinationWarpCruise,
      maneuver: Math.max(
        brakeRequested ? 1 : 0,
        Math.abs(flightInput.strafe),
        Math.abs(flightInput.lift),
        Math.abs(flightInput.pitch),
        Math.abs(flightInput.roll),
      ),
    });
    if (this.shipAutopilotPhase !== "landing") this.spaceship.updateFlight(delta, flightInput);
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
    const warpIntensity = this.spaceship.getWarpEffectIntensity();
    this.camera.fov = spaceshipDampedInput(
      this.camera.fov,
      THREE.MathUtils.lerp(SHIP_CAMERA_BASE_FOV_DEG, SHIP_CAMERA_WARP_FOV_DEG, warpIntensity),
      warpIntensity > 0 ? 14 : 4,
      delta,
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

  update(deltaSeconds: number, elapsedSeconds = deltaSeconds): PlanetControlState {
    const elapsedDelta = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
    const delta = clamp(deltaSeconds, 0, 0.05);
    if (this.traverseMode === "spaceship") return this.updateSpaceship(delta, elapsedDelta);
    this.entryWheelLockSeconds = Math.max(0, this.entryWheelLockSeconds - delta);
    this.spaceship.updateParkedPosition();
    this.setLocalBasis();
    const speedMps = this.jumpAnticipationSeconds > 0 ? 0 : this.updateMovement(delta);
    this.setLocalBasis();
    const airborne = this.updateJump(delta);
    this.updateAnimation(speedMps, airborne, delta);
    this.updateFootsteps(speedMps, airborne || this.jumpAnticipationSeconds > 0);

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
    this.updateSuitThrusters(airborne, delta);

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
        this.shipAutoFlightMode = nextSpaceshipAutoFlightMode(this.shipAutoFlightMode);
        if (this.shipAutoFlightMode === "off") this.cancelSpaceshipAutomation();
        this.shipBrakeRequested = false;
        return;
      }
      if ([
        "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyZ", "KeyC", "KeyX", "KeyF", "Space",
        "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight",
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      ].includes(event.code)) event.preventDefault();
      if (isSpaceshipManualFlightControlKey(event.code)) this.cancelSpaceshipAutomation();
      if (event.code === "KeyF" && !event.repeat) {
        this.shipWarpBurstRequested = true;
        this.onAudioEvent({ type: "warp" });
        return;
      }
      if (event.code === "KeyX" && !event.repeat) {
        this.shipBrakeRequested = true;
      }
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
        this.resetFootstepSync();
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
    this.cancelSpaceshipAutomation();
    this.shipWarpBurstRequested = false;
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
      if (spaceshipMouseForward(this.mouseButtons.has(0), this.mouseButtons.has(2))) {
        this.cancelSpaceshipAutomation();
      }
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
    for (const plume of this.suitThrusterPlumes) {
      plume.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) material.dispose();
      });
    }
    this.root.removeFromParent();
    this.localFill.removeFromParent();
  }
}
