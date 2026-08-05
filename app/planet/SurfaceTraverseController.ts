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
const CAMERA_MIN_DISTANCE_M = 3.2;
const CAMERA_MAX_DISTANCE_M = 14;
const CAMERA_TARGET_HEIGHT_M = 1.38;
const CAMERA_MIN_PITCH_RAD = THREE.MathUtils.degToRad(-60);
const CAMERA_MAX_PITCH_RAD = THREE.MathUtils.degToRad(80);
const BOOT_SOLE_CLEARANCE_M = 0.025;

type AnimationName = "idle" | "walk" | "run" | "jump" | "jump_idle" | "jump_land";

export type TraverseSurfaceSample = {
  heightM: number;
  normal: Vec3;
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

export function marsJumpApexHeight(launchSpeedMps = MARS_TRAVERSE_JUMP_SPEED_M_S) {
  return (launchSpeedMps * launchSpeedMps) / (2 * MARS_SURFACE_GRAVITY_M_S2);
}

export function applyWowCameraDrag(
  cameraYawRad: number,
  cameraPitchRad: number,
  headingRad: number,
  deltaX: number,
  deltaY: number,
  steeringCharacter: boolean,
) {
  const nextCameraYawRad = cameraYawRad + deltaX * 0.0042;
  return {
    cameraYawRad: nextCameraYawRad,
    cameraPitchRad: clamp(
      cameraPitchRad + deltaY * 0.0032,
      CAMERA_MIN_PITCH_RAD,
      CAMERA_MAX_PITCH_RAD,
    ),
    headingRad: steeringCharacter ? nextCameraYawRad : headingRad,
  };
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
  private readonly cameraDirection = new THREE.Vector3();
  private readonly footAbsolute = new THREE.Vector3();
  private readonly playerAbsolute = new THREE.Vector3();
  private readonly targetAbsolute = new THREE.Vector3();
  private readonly north = new THREE.Vector3();
  private readonly east = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly surfaceNormal = new THREE.Vector3(1, 0, 0);
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly modelForward = new THREE.Vector3();
  private readonly modelRight = new THREE.Vector3();
  private readonly move = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly relativeTarget = new THREE.Vector3();
  private readonly orientation = new THREE.Matrix4();
  private readonly keys = new Set<string>();
  private readonly mouseButtons = new Set<number>();
  private readonly actions = new Map<AnimationName, THREE.AnimationAction>();
  private mixer: THREE.AnimationMixer | null = null;
  private currentAction: THREE.AnimationAction | null = null;
  private model: THREE.Object3D | null = null;
  private pointerId: number | null = null;
  private pointerX = 0;
  private pointerY = 0;
  private headingRad = 0;
  private cameraYawRad = 0;
  private cameraPitchRad = THREE.MathUtils.degToRad(18);
  private cameraDistanceM = 7;
  private verticalOffsetM = 0;
  private verticalVelocityMps = 0;
  private airborneSeconds = 0;
  private landingSeconds = 0;
  private footstepCountdown = 0;
  private groundHeightM = 0;
  private surveyFovDegrees: number;
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
        if (!(child instanceof THREE.Mesh)) return;
        child.castShadow = true;
        child.receiveShadow = true;
        child.frustumCulled = false;
      });
      this.root.add(this.model);

      this.mixer = new THREE.AnimationMixer(this.model);
      for (const clip of gltf.animations) {
        const suffix = clip.name.split("|").at(-1)?.toLowerCase();
        if (!suffix || !["idle", "walk", "run", "jump", "jump_idle", "jump_land"].includes(suffix)) continue;
        this.actions.set(suffix as AnimationName, this.mixer.clipAction(clip));
      }
      this.playAnimation("idle", 0);
    } catch (error) {
      console.error("Unable to load the CC0 astronaut", error);
      this.onAssetError("The CC0 astronaut model could not be loaded.");
    }
  }

  teleportRandom(random: () => number = Math.random) {
    const wasActive = this.active;
    const next = randomMarsSurfaceDirection(random);
    this.direction.set(next.x, next.y, next.z).normalize();
    this.headingRad = random() * Math.PI * 2;
    this.cameraYawRad = this.headingRad;
    this.cameraPitchRad = THREE.MathUtils.degToRad(18);
    this.cameraDistanceM = 7;
    this.verticalOffsetM = 0;
    this.verticalVelocityMps = 0;
    this.airborneSeconds = 0;
    this.landingSeconds = 0;
    this.footstepCountdown = 0;
    this.keys.clear();
    this.mouseButtons.clear();
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
    this.camera.fov = this.surveyFovDegrees;
    this.camera.updateProjectionMatrix();
  }

  getSurfaceDirection(): Vec3 {
    return { x: this.direction.x, y: this.direction.y, z: this.direction.z };
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

    let forwardInput = Number(this.keys.has("KeyW") || this.keys.has("ArrowUp"))
      - Number(this.keys.has("KeyS") || this.keys.has("ArrowDown"));
    if (this.mouseButtons.has(0) && rightMouse) forwardInput += 1;
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
    if (this.verticalOffsetM <= 0 && this.verticalVelocityMps <= 0) {
      this.verticalOffsetM = 0;
      return false;
    }
    this.airborneSeconds += deltaSeconds;
    this.verticalVelocityMps -= MARS_SURFACE_GRAVITY_M_S2 * deltaSeconds;
    this.verticalOffsetM += this.verticalVelocityMps * deltaSeconds;
    if (this.verticalOffsetM <= 0) {
      this.verticalOffsetM = 0;
      this.verticalVelocityMps = 0;
      this.airborneSeconds = 0;
      this.landingSeconds = 0.28;
      this.footstepCountdown = 0;
      this.onAudioEvent({ type: "land" });
      return false;
    }
    return true;
  }

  private updateAnimation(speedMps: number, airborne: boolean, deltaSeconds: number) {
    if (airborne) {
      this.playAnimation(this.verticalVelocityMps > -0.4 && this.airborneSeconds < 0.9 ? "jump" : "jump_idle");
    } else if (this.landingSeconds > 0) {
      this.landingSeconds = Math.max(0, this.landingSeconds - deltaSeconds);
      this.playAnimation("jump_land");
    } else if (speedMps >= RUN_SPEED_M_S - 0.1) {
      this.playAnimation("run");
    } else if (speedMps > 0) {
      this.playAnimation("walk");
    } else {
      this.playAnimation("idle");
    }
    this.mixer?.update(deltaSeconds);
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

  update(deltaSeconds: number): PlanetControlState {
    const delta = clamp(deltaSeconds, 0, 0.05);
    this.setLocalBasis();
    const speedMps = this.updateMovement(delta);
    this.setLocalBasis();
    const airborne = this.updateJump(delta);
    this.updateAnimation(speedMps, airborne, delta);
    this.updateFootsteps(speedMps, airborne, delta);

    const surface = this.terrainSurface(this.direction);
    this.groundHeightM = surface.heightM;
    this.surfaceNormal.set(surface.normal.x, surface.normal.y, surface.normal.z).normalize();
    if (this.surfaceNormal.dot(this.direction) < 0) this.surfaceNormal.negate();
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

    this.headingVector(this.cameraYawRad, this.forward);
    this.forward.addScaledVector(this.surfaceNormal, -this.forward.dot(this.surfaceNormal)).normalize();
    this.targetAbsolute.copy(this.playerAbsolute).addScaledVector(this.surfaceNormal, CAMERA_TARGET_HEIGHT_M);
    const horizontalDistance = Math.cos(this.cameraPitchRad) * this.cameraDistanceM;
    const verticalDistance = Math.sin(this.cameraPitchRad) * this.cameraDistanceM;
    this.cameraAbsolute.copy(this.targetAbsolute)
      .addScaledVector(this.forward, -horizontalDistance)
      .addScaledVector(this.surfaceNormal, verticalDistance);

    this.cameraDirection.copy(this.cameraAbsolute).normalize();
    const cameraGroundM = this.terrainSurface(this.cameraDirection).heightM;
    let cameraAltitudeM = this.cameraAbsolute.length() - MARS_REFERENCE_RADIUS_M - cameraGroundM;
    if (cameraAltitudeM < 0.65) {
      this.cameraAbsolute.addScaledVector(this.cameraDirection, 0.65 - cameraAltitudeM);
      cameraAltitudeM = 0.65;
    }
    this.cameraDirection.copy(this.cameraAbsolute).normalize();

    this.root.position.copy(this.playerAbsolute).sub(this.cameraAbsolute);
    this.camera.position.set(0, 0, 0);
    this.camera.up.copy(this.surfaceNormal);
    this.relativeTarget.copy(this.targetAbsolute).sub(this.cameraAbsolute);
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
      cameraDistanceM: this.cameraDistanceM,
      nearM: this.camera.near,
      farM: this.camera.far,
    };
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (!this.active) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (event.code === "Space") {
      event.preventDefault();
      if (!event.repeat && this.verticalOffsetM <= 0.001 && this.verticalVelocityMps === 0) {
        this.verticalVelocityMps = MARS_TRAVERSE_JUMP_SPEED_M_S;
        this.verticalOffsetM = 0.001;
        this.airborneSeconds = 0;
        this.landingSeconds = 0;
        this.footstepCountdown = 0;
        this.playAnimation("jump");
        this.onAudioEvent({ type: "jump" });
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
  };

  private onContextMenu = (event: MouseEvent) => {
    if (this.active) event.preventDefault();
  };

  private onPointerDown = (event: PointerEvent) => {
    if (!this.active || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault();
    this.mouseButtons.add(event.button);
    this.pointerId = event.pointerId;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.active || this.pointerId !== event.pointerId || this.mouseButtons.size === 0) return;
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
    this.mouseButtons.delete(event.button);
    if (event.buttons === 0) {
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.pointerId = null;
      this.mouseButtons.clear();
    }
  };

  private onWheel = (event: WheelEvent) => {
    if (!this.active) return;
    event.preventDefault();
    const factor = Math.exp(event.deltaY * 0.0012);
    this.cameraDistanceM = clamp(this.cameraDistanceM * factor, CAMERA_MIN_DISTANCE_M, CAMERA_MAX_DISTANCE_M);
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
