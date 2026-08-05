import * as THREE from "three";
import {
  CAMERA_SURFACE_EPSILON_M,
  MARS_MOON_MAX_ORBIT_RADIUS_M,
  MAX_CAMERA_ALTITUDE_M,
  MARS_ATMOSPHERE_TOP_M,
  MARS_REFERENCE_RADIUS_M,
  MIN_CAMERA_ALTITUDE_M,
  RENDER_CONFIG,
} from "./constants";
import {
  cartesianToLatLonElevation,
  clamp,
  latLonElevationToCartesian,
  nonlinearZoomAltitude,
  rayTerrainIntersection,
} from "./math";
import type { Vec3 } from "./types";

export type PlanetControlState = {
  cameraAbsolute: Vec3;
  cameraDirection: Vec3;
  focusDirection: Vec3;
  focusAbsolute: Vec3;
  altitudeM: number;
  desiredAltitudeM: number;
  cameraDistanceM: number;
  nearM: number;
  farM: number;
};

type PointerDrag = { id: number; button: number; lastX: number; lastY: number };

function smoothstep(minimum: number, maximum: number, value: number) {
  const t = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return t * t * (3 - 2 * t);
}

export function automaticApproachPitchDegrees(altitudeM: number) {
  const orbitalApproach = 1 - smoothstep(25_000, 350_000, altitudeM);
  const surfaceApproach = 1 - smoothstep(1_200, 12_000, altitudeM);
  // At eye height an 80-degree offset from the surface normal looks only ten
  // degrees down. The horizon therefore remains inside the 42-degree frame,
  // while the ground focus stays roughly twelve metres in front of the player.
  return 52 * orbitalApproach + 28 * surfaceApproach;
}

/**
 * Quaternion trackball controls for a curved, camera-relative planet.
 * The orbit vector has no Euler poles or horizontal/vertical angle limits.
 */
export class PlanetControls {
  private readonly focusDirection = new THREE.Vector3();
  private readonly orbitDirection = new THREE.Vector3();
  private readonly viewUp = new THREE.Vector3();
  private readonly cameraAbsolute = new THREE.Vector3();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly focusAbsolute = new THREE.Vector3();
  private readonly cursorNdc = new THREE.Vector2();
  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly scratchC = new THREE.Vector3();
  private readonly scratchD = new THREE.Vector3();
  private readonly yawQuaternion = new THREE.Quaternion();
  private readonly pitchQuaternion = new THREE.Quaternion();
  private transientZoomAnchor: THREE.Vector3 | null = null;
  private lockedZoomAnchor: THREE.Vector3 | null = null;
  private cameraDistanceM = 10_000_000 + CAMERA_SURFACE_EPSILON_M;
  private desiredCameraDistanceM = this.cameraDistanceM;
  private desiredAltitudeM = 10_000_000;
  private altitudeM = 10_000_000;
  private automaticApproachEnabled = true;
  private automaticApproachPitchRad = 0;
  private drag: PointerDrag | null = null;
  private enabled = true;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly terrainHeight: (direction: Vec3) => number,
    private readonly prefetch: (direction: Vec3) => void,
  ) {
    const initial = latLonElevationToCartesian(18.65, -133.8, 0, 1);
    this.focusDirection.set(initial.x, initial.y, initial.z).normalize();
    // Start on the local sky side of the selected point. A fixed world-space
    // vector can point through Mars at some longitudes, which made descent end
    // on the opposite hemisphere and presented as a black surface.
    this.orbitDirection.copy(this.focusDirection);
    this.viewUp.set(0, 1, 0).addScaledVector(this.orbitDirection, -this.orbitDirection.y);
    if (this.viewUp.lengthSq() < 1e-10) this.viewUp.set(0, 0, 1);
    this.viewUp.normalize();
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
    this.update(1 / 60);
  }

  private onContextMenu = (event: MouseEvent) => event.preventDefault();

  private updateCursor(event: PointerEvent | WheelEvent) {
    const bounds = this.canvas.getBoundingClientRect();
    this.cursorNdc.set(
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1,
      -((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 + 1,
    );
  }

  private onPointerDown = (event: PointerEvent) => {
    if (!this.enabled) return;
    this.updateCursor(event);
    if (event.button !== 1 && event.button !== 2) return;
    event.preventDefault();
    if (event.button === 2) {
      this.lockedZoomAnchor = null;
      this.transientZoomAnchor = null;
    }
    this.drag = { id: event.pointerId, button: event.button, lastX: event.clientX, lastY: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.enabled) return;
    this.updateCursor(event);
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const dx = event.clientX - this.drag.lastX;
    const dy = event.clientY - this.drag.lastY;
    this.drag.lastX = event.clientX;
    this.drag.lastY = event.clientY;
    if (this.drag.button === 1) this.orbit(dx, dy);
    else this.pan(dx, dy);
    event.preventDefault();
  };

  private onPointerUp = (event: PointerEvent) => {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.drag = null;
  };

  private orbit(dx: number, dy: number) {
    // Once the player takes the orbit control, their orientation is
    // authoritative. Automatic approach pitch never fights a middle drag.
    this.automaticApproachEnabled = false;
    // Rotate one fixed camera offset around an unchanged focus point.
    const oldOrbit = this.scratchA.copy(this.orbitDirection);
    const oldUp = this.scratchB.copy(this.viewUp);
    this.yawQuaternion.setFromAxisAngle(this.viewUp, -dx * 0.0032);
    this.orbitDirection.applyQuaternion(this.yawQuaternion).normalize();
    this.viewUp.applyQuaternion(this.yawQuaternion).normalize();

    const screenRight = this.scratchC
      .crossVectors(this.scratchD.copy(this.orbitDirection).multiplyScalar(-1), this.viewUp)
      .normalize();
    this.pitchQuaternion.setFromAxisAngle(screenRight, -dy * 0.0032);
    this.orbitDirection.applyQuaternion(this.pitchQuaternion).normalize();
    this.viewUp.applyQuaternion(this.pitchQuaternion);
    this.viewUp.addScaledVector(this.orbitDirection, -this.viewUp.dot(this.orbitDirection)).normalize();

    // Orbit angles are intentionally unbounded. Only reject an endpoint that
    // would put the camera inside local terrain; at orbital distance this
    // permits complete, repeated rotations in every screen-space direction.
    if (this.cameraAltitudeAtDistance(this.cameraDistanceM) < CAMERA_SURFACE_EPSILON_M) {
      this.orbitDirection.copy(oldOrbit);
      this.viewUp.copy(oldUp);
      return;
    }
    this.finishGesture();
  }

  private pan(dx: number, dy: number) {
    // Translate camera and focus together in the current view plane. The offset
    // and view-up vectors do not change, so panning cannot become an orbit or roll.
    const oldFocus = this.scratchA.copy(this.focusDirection);
    const screenRight = this.scratchB
      .crossVectors(this.scratchD.copy(this.orbitDirection).multiplyScalar(-1), this.viewUp)
      .normalize();
    const screenUp = this.scratchC.copy(this.viewUp);
    screenRight.addScaledVector(oldFocus, -screenRight.dot(oldFocus));
    screenUp.addScaledVector(oldFocus, -screenUp.dot(oldFocus));
    if (screenRight.lengthSq() < 1e-10) screenRight.crossVectors(screenUp, oldFocus);
    if (screenUp.lengthSq() < 1e-10) screenUp.crossVectors(oldFocus, screenRight);
    screenRight.normalize();
    screenUp.normalize();
    const viewportHeight = Math.max(1, this.canvas.clientHeight || this.canvas.getBoundingClientRect().height || 1);
    const metresPerPixel = 2 * this.cameraDistanceM
      * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5)
      / viewportHeight;
    const nextFocus = this.scratchD.copy(oldFocus)
      .addScaledVector(screenRight, (-dx * metresPerPixel) / MARS_REFERENCE_RADIUS_M)
      .addScaledVector(screenUp, (dy * metresPerPixel) / MARS_REFERENCE_RADIUS_M)
      .normalize();
    this.focusDirection.copy(nextFocus);
    this.updateFocusAbsolute();
    this.finishGesture();
    this.prefetch(this.focusDirection);
  }

  private updateFocusAbsolute() {
    const focusRadius = MARS_REFERENCE_RADIUS_M + this.terrainHeight(this.focusDirection);
    this.focusAbsolute.copy(this.focusDirection).multiplyScalar(focusRadius);
  }

  private cameraAltitudeAtDistance(distanceM: number) {
    const position = this.scratchD.copy(this.focusAbsolute).addScaledVector(this.orbitDirection, distanceM);
    const direction = this.scratchC.copy(position).normalize();
    return position.length() - MARS_REFERENCE_RADIUS_M - this.terrainHeight(direction);
  }

  private distanceForAltitude(altitudeM: number) {
    // Begin on the local terrain radius, not the datum sphere. Starting at the
    // datum can put the first quadratic target kilometres below a high or low
    // focus point; with only two corrections the camera then settles far above
    // the requested AGL on real MOLA slopes.
    let cameraRadius = this.focusAbsolute.length() + altitudeM + CAMERA_SURFACE_EPSILON_M;
    let distance = this.cameraDistanceM;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const projected = this.focusAbsolute.dot(this.orbitDirection);
      const discriminant = Math.max(
        0,
        projected * projected + cameraRadius * cameraRadius - this.focusAbsolute.lengthSq(),
      );
      distance = Math.max(CAMERA_SURFACE_EPSILON_M, -projected + Math.sqrt(discriminant));
      const position = this.scratchD.copy(this.focusAbsolute).addScaledVector(this.orbitDirection, distance);
      const direction = this.scratchC.copy(position).normalize();
      const nextRadius = MARS_REFERENCE_RADIUS_M + this.terrainHeight(direction) + altitudeM + CAMERA_SURFACE_EPSILON_M;
      if (Math.abs(nextRadius - cameraRadius) < 0.01) break;
      cameraRadius = nextRadius;
    }
    const aglAtDistance = (candidateDistanceM: number) =>
      this.cameraAltitudeAtDistance(candidateDistanceM) - CAMERA_SURFACE_EPSILON_M;
    if (Math.abs(aglAtDistance(distance) - altitudeM) < 0.02) return distance;

    // Rugged real terrain is not a concentric sphere, so fixed-point radius
    // correction can oscillate between a crater floor and rim. Bracket the
    // requested AGL along the actual camera ray and finish with a bounded
    // binary solve. This path only runs when the cheap spherical solve misses.
    let lower = CAMERA_SURFACE_EPSILON_M;
    let upper = Math.max(distance, altitudeM + 10);
    let upperAltitude = aglAtDistance(upper);
    for (let expansion = 0; expansion < 12 && upperAltitude < altitudeM; expansion += 1) {
      lower = upper;
      upper *= 2;
      upperAltitude = aglAtDistance(upper);
    }
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const midpoint = (lower + upper) * 0.5;
      if (aglAtDistance(midpoint) < altitudeM) lower = midpoint;
      else upper = midpoint;
    }
    return (lower + upper) * 0.5;
  }

  private finishGesture() {
    this.desiredCameraDistanceM = this.cameraDistanceM;
    this.altitudeM = Math.max(
      MIN_CAMERA_ALTITUDE_M,
      this.cameraAltitudeAtDistance(this.cameraDistanceM) - CAMERA_SURFACE_EPSILON_M,
    );
    this.desiredAltitudeM = this.altitudeM;
    this.transientZoomAnchor = null;
  }

  private onWheel = (event: WheelEvent) => {
    if (!this.enabled) return;
    event.preventDefault();
    this.updateCursor(event);
    // WheelEvent constants are 1 (line) and 2 (page). Using the values keeps
    // this input path deterministic in browser integration/SSR test harnesses.
    const modeScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 480 : 1;
    const previous = this.desiredAltitudeM;
    this.desiredAltitudeM = nonlinearZoomAltitude(this.desiredAltitudeM, event.deltaY * modeScale);
    this.desiredCameraDistanceM = this.distanceForAltitude(this.desiredAltitudeM);
    if (this.lockedZoomAnchor) this.transientZoomAnchor = null;
    else if (this.desiredAltitudeM < previous) this.transientZoomAnchor = this.cursorSurfacePoint();
    else this.transientZoomAnchor = null;
  };

  private cursorSurfacePoint() {
    const ray = this.scratchA.set(this.cursorNdc.x, this.cursorNdc.y, 0.4).unproject(this.camera).normalize();
    const origin = { x: this.cameraAbsolute.x, y: this.cameraAbsolute.y, z: this.cameraAbsolute.z };
    const hit = rayTerrainIntersection(origin, ray, this.terrainHeight);
    return hit ? new THREE.Vector3(hit.direction.x, hit.direction.y, hit.direction.z) : null;
  }

  private moveFocusTowardZoomAnchor(anchor: THREE.Vector3, amount: number) {
    this.focusDirection.lerp(anchor, amount).normalize();
    if (anchor === this.transientZoomAnchor && this.focusDirection.angleTo(anchor) < 1e-7) {
      this.transientZoomAnchor = null;
    }
  }

  private updateAutomaticApproach(deltaSeconds: number) {
    if (!this.automaticApproachEnabled) return;

    // Preserve a nadir view at planetary scale, ease into an oblique survey
    // composition, then lower the sightline again for a genuine surface view.
    // This second stage is essential: a 48-degree orbit offset points 42
    // degrees down and places the horizon completely outside a 42-degree FOV.
    const targetPitchRad = THREE.MathUtils.degToRad(automaticApproachPitchDegrees(this.altitudeM));
    const smoothing = 1 - Math.exp(-Math.max(0, deltaSeconds) * 7.5);
    const nextPitchRad = THREE.MathUtils.lerp(
      this.automaticApproachPitchRad,
      targetPitchRad,
      smoothing,
    );
    const pitchDeltaRad = nextPitchRad - this.automaticApproachPitchRad;
    this.automaticApproachPitchRad = Math.abs(targetPitchRad - nextPitchRad) < 1e-8
      ? targetPitchRad
      : nextPitchRad;
    if (Math.abs(pitchDeltaRad) < 1e-10) return;

    const screenRight = this.scratchC
      .crossVectors(this.scratchD.copy(this.orbitDirection).multiplyScalar(-1), this.viewUp)
      .normalize();
    this.pitchQuaternion.setFromAxisAngle(screenRight, pitchDeltaRad);
    this.orbitDirection.applyQuaternion(this.pitchQuaternion).normalize();
    this.viewUp.applyQuaternion(this.pitchQuaternion);
    this.viewUp.addScaledVector(this.orbitDirection, -this.viewUp.dot(this.orbitDirection)).normalize();

    // Re-solve the offset after changing its direction so approach pitching
    // does not itself move the camera toward or away from the ground.
    this.updateFocusAbsolute();
    this.cameraDistanceM = this.distanceForAltitude(this.altitudeM);
  }

  update(deltaSeconds: number): PlanetControlState {
    if (this.disposed) throw new Error("PlanetControls has been disposed");
    // MOLA may arrive after the camera target was established. Re-solve the
    // distance from the authoritative requested AGL so streamed macro terrain
    // cannot silently move the camera above the public maximum or below ground.
    this.updateAutomaticApproach(deltaSeconds);
    this.updateFocusAbsolute();
    this.desiredCameraDistanceM = this.distanceForAltitude(this.desiredAltitudeM);
    const smoothing = 1 - Math.exp(-Math.max(0, deltaSeconds) * 10.5);
    const previousDistanceM = this.cameraDistanceM;
    const distanceDifference = this.desiredCameraDistanceM - this.cameraDistanceM;
    this.cameraDistanceM += distanceDifference * smoothing;
    if (Math.abs(distanceDifference) < 0.001) this.cameraDistanceM = this.desiredCameraDistanceM;
    const zoomAnchor = this.lockedZoomAnchor ?? this.transientZoomAnchor;
    if (zoomAnchor && this.cameraDistanceM !== previousDistanceM) {
      // In the local planar limit this is the exact target interpolation needed
      // to keep the picked ground point stationary as camera distance changes.
      // A signed fraction also preserves the point while zooming out. Applying
      // only the realised distance step prevents residual target drift once
      // smooth zooming has settled.
      const fraction = clamp(
        1 - (this.cameraDistanceM + 2.5) / Math.max(previousDistanceM + 2.5, 2.5),
        -0.42,
        0.42,
      );
      this.moveFocusTowardZoomAnchor(zoomAnchor, fraction);
    }

    this.updateFocusAbsolute();
    this.cameraAbsolute.copy(this.focusAbsolute).addScaledVector(this.orbitDirection, this.cameraDistanceM);
    this.cameraDirection.copy(this.cameraAbsolute).normalize();
    let actualAltitude = this.cameraAbsolute.length()
      - MARS_REFERENCE_RADIUS_M
      - this.terrainHeight(this.cameraDirection)
      - CAMERA_SURFACE_EPSILON_M;
    if (actualAltitude < MIN_CAMERA_ALTITUDE_M) {
      this.cameraDistanceM = this.distanceForAltitude(MIN_CAMERA_ALTITUDE_M);
      this.desiredCameraDistanceM = Math.max(this.desiredCameraDistanceM, this.cameraDistanceM);
      this.cameraAbsolute.copy(this.focusAbsolute).addScaledVector(this.orbitDirection, this.cameraDistanceM);
      this.cameraDirection.copy(this.cameraAbsolute).normalize();
      actualAltitude = MIN_CAMERA_ALTITUDE_M;
    } else if (actualAltitude > MAX_CAMERA_ALTITUDE_M) {
      this.cameraDistanceM = this.distanceForAltitude(MAX_CAMERA_ALTITUDE_M);
      this.desiredCameraDistanceM = Math.min(this.desiredCameraDistanceM, this.cameraDistanceM);
      this.cameraAbsolute.copy(this.focusAbsolute).addScaledVector(this.orbitDirection, this.cameraDistanceM);
      this.cameraDirection.copy(this.cameraAbsolute).normalize();
      actualAltitude = MAX_CAMERA_ALTITUDE_M;
    }
    this.altitudeM = clamp(actualAltitude, MIN_CAMERA_ALTITUDE_M, MAX_CAMERA_ALTITUDE_M);

    this.camera.position.set(0, 0, 0);
    const targetRelative = this.scratchA.copy(this.focusAbsolute).sub(this.cameraAbsolute);
    this.camera.up.copy(this.viewUp);
    this.camera.lookAt(targetRelative);
    const near = clamp(actualAltitude * 0.000006, RENDER_CONFIG.surfaceNearM, 180);
    const terrainFar = actualAltitude > 150_000
      ? actualAltitude + MARS_REFERENCE_RADIUS_M * 2.15 + MARS_ATMOSPHERE_TOP_M
      : Math.max(350_000, Math.sqrt(2 * MARS_REFERENCE_RADIUS_M * (actualAltitude + MARS_ATMOSPHERE_TOP_M)) * 3.2);
    const far = Math.max(
      terrainFar,
      this.cameraAbsolute.length() + MARS_MOON_MAX_ORBIT_RADIUS_M + 50_000,
    );
    if (Math.abs(this.camera.near - near) / near > 0.02 || Math.abs(this.camera.far - far) / far > 0.02) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld(true);

    return {
      cameraAbsolute: { x: this.cameraAbsolute.x, y: this.cameraAbsolute.y, z: this.cameraAbsolute.z },
      cameraDirection: { x: this.cameraDirection.x, y: this.cameraDirection.y, z: this.cameraDirection.z },
      focusDirection: { x: this.focusDirection.x, y: this.focusDirection.y, z: this.focusDirection.z },
      focusAbsolute: { x: this.focusAbsolute.x, y: this.focusAbsolute.y, z: this.focusAbsolute.z },
      altitudeM: this.altitudeM,
      desiredAltitudeM: this.desiredAltitudeM,
      cameraDistanceM: this.cameraDistanceM,
      nearM: near,
      farM: far,
    };
  }

  setLocation(latitudeDeg: number, longitudeDeg: number, altitudeM = this.desiredAltitudeM) {
    const direction = latLonElevationToCartesian(latitudeDeg, longitudeDeg, 0, 1);
    this.focusDirection.set(direction.x, direction.y, direction.z).normalize();
    this.orbitDirection.copy(this.focusDirection);
    this.viewUp.set(0, 1, 0).addScaledVector(this.orbitDirection, -this.orbitDirection.y);
    if (this.viewUp.lengthSq() < 1e-10) this.viewUp.set(0, 0, 1);
    this.viewUp.normalize();
    this.automaticApproachEnabled = true;
    this.automaticApproachPitchRad = 0;
    this.updateFocusAbsolute();
    this.altitudeM = this.desiredAltitudeM = clamp(altitudeM, MIN_CAMERA_ALTITUDE_M, MAX_CAMERA_ALTITUDE_M);
    this.cameraDistanceM = this.desiredCameraDistanceM = this.distanceForAltitude(this.desiredAltitudeM);
    this.transientZoomAnchor = null;
    this.lockedZoomAnchor = null;
    this.prefetch(this.focusDirection);
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled || !this.drag) return;
    if (this.canvas.hasPointerCapture(this.drag.id)) this.canvas.releasePointerCapture(this.drag.id);
    this.drag = null;
  }

  setZoomAnchor(direction: Vec3 | null) {
    this.transientZoomAnchor = null;
    if (!direction) {
      this.lockedZoomAnchor = null;
      return;
    }
    const anchor = new THREE.Vector3(direction.x, direction.y, direction.z);
    this.lockedZoomAnchor = anchor.lengthSq() > 1e-12 ? anchor.normalize() : null;
  }

  setAltitude(altitudeM: number, immediate = false) {
    this.desiredAltitudeM = clamp(altitudeM, MIN_CAMERA_ALTITUDE_M, MAX_CAMERA_ALTITUDE_M);
    this.updateFocusAbsolute();
    this.desiredCameraDistanceM = this.distanceForAltitude(this.desiredAltitudeM);
    if (immediate) {
      this.cameraDistanceM = this.desiredCameraDistanceM;
      this.altitudeM = this.desiredAltitudeM;
    }
  }

  getState() {
    return {
      latitudeLongitude: cartesianToLatLonElevation(this.focusDirection, 1),
      altitudeM: this.altitudeM,
      desiredAltitudeM: this.desiredAltitudeM,
      cameraDistanceM: this.cameraDistanceM,
      orbitDirection: { x: this.orbitDirection.x, y: this.orbitDirection.y, z: this.orbitDirection.z },
      automaticApproachEnabled: this.automaticApproachEnabled,
      approachPitchDeg: THREE.MathUtils.radToDeg(this.automaticApproachPitchRad),
      zoomAnchorLocked: this.lockedZoomAnchor !== null,
    };
  }

  dispose() {
    this.disposed = true;
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
  }
}
