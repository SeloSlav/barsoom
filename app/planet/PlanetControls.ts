import * as THREE from "three";
import {
  CAMERA_SURFACE_EPSILON_M,
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
  nearM: number;
  farM: number;
};

type PointerDrag = { id: number; button: number; lastX: number; lastY: number };

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
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly yawQuaternion = new THREE.Quaternion();
  private readonly pitchQuaternion = new THREE.Quaternion();
  private zoomAnchor: THREE.Vector3 | null = null;
  private cameraDistanceM = 10_000_000 + CAMERA_SURFACE_EPSILON_M;
  private desiredCameraDistanceM = this.cameraDistanceM;
  private desiredAltitudeM = 10_000_000;
  private altitudeM = 10_000_000;
  private drag: PointerDrag | null = null;
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
    this.updateCursor(event);
    if (event.button !== 1 && event.button !== 2) return;
    event.preventDefault();
    this.drag = { id: event.pointerId, button: event.button, lastX: event.clientX, lastY: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
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
    let cameraRadius = MARS_REFERENCE_RADIUS_M + altitudeM + CAMERA_SURFACE_EPSILON_M;
    let distance = this.cameraDistanceM;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const projected = this.focusAbsolute.dot(this.orbitDirection);
      const discriminant = Math.max(
        0,
        projected * projected + cameraRadius * cameraRadius - this.focusAbsolute.lengthSq(),
      );
      distance = Math.max(CAMERA_SURFACE_EPSILON_M, -projected + Math.sqrt(discriminant));
      const position = this.scratchD.copy(this.focusAbsolute).addScaledVector(this.orbitDirection, distance);
      const direction = this.scratchC.copy(position).normalize();
      cameraRadius = MARS_REFERENCE_RADIUS_M + this.terrainHeight(direction) + altitudeM + CAMERA_SURFACE_EPSILON_M;
    }
    return distance;
  }

  private finishGesture() {
    this.desiredCameraDistanceM = this.cameraDistanceM;
    this.altitudeM = Math.max(0, this.cameraAltitudeAtDistance(this.cameraDistanceM) - CAMERA_SURFACE_EPSILON_M);
    this.desiredAltitudeM = this.altitudeM;
    this.zoomAnchor = null;
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.updateCursor(event);
    // WheelEvent constants are 1 (line) and 2 (page). Using the values keeps
    // this input path deterministic in browser integration/SSR test harnesses.
    const modeScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 480 : 1;
    const previous = this.desiredAltitudeM;
    this.desiredAltitudeM = nonlinearZoomAltitude(this.desiredAltitudeM, event.deltaY * modeScale);
    this.desiredCameraDistanceM = this.distanceForAltitude(this.desiredAltitudeM);
    if (this.desiredAltitudeM < previous) this.zoomAnchor = this.cursorSurfacePoint();
    else this.zoomAnchor = null;
  };

  private cursorSurfacePoint() {
    const ray = this.scratchA.set(this.cursorNdc.x, this.cursorNdc.y, 0.4).unproject(this.camera).normalize();
    const origin = { x: this.cameraAbsolute.x, y: this.cameraAbsolute.y, z: this.cameraAbsolute.z };
    const hit = rayTerrainIntersection(origin, ray, this.terrainHeight);
    return hit ? new THREE.Vector3(hit.direction.x, hit.direction.y, hit.direction.z) : null;
  }

  private moveFocusTowardZoomAnchor(amount: number) {
    if (!this.zoomAnchor) return;
    this.focusDirection.lerp(this.zoomAnchor, amount).normalize();
    if (this.focusDirection.angleTo(this.zoomAnchor) < 1e-7) this.zoomAnchor = null;
  }

  update(deltaSeconds: number): PlanetControlState {
    if (this.disposed) throw new Error("PlanetControls has been disposed");
    // MOLA may arrive after the camera target was established. Re-solve the
    // distance from the authoritative requested AGL so streamed macro terrain
    // cannot silently move the camera above the public maximum or below ground.
    this.updateFocusAbsolute();
    this.desiredCameraDistanceM = this.distanceForAltitude(this.desiredAltitudeM);
    const smoothing = 1 - Math.exp(-Math.max(0, deltaSeconds) * 10.5);
    const previousDistanceM = this.cameraDistanceM;
    const distanceDifference = this.desiredCameraDistanceM - this.cameraDistanceM;
    this.cameraDistanceM += distanceDifference * smoothing;
    if (Math.abs(distanceDifference) < 0.001) this.cameraDistanceM = this.desiredCameraDistanceM;
    if (this.zoomAnchor && this.cameraDistanceM < previousDistanceM) {
      // In the local planar limit this is the exact target interpolation needed
      // to keep the picked ground point stationary as camera distance changes.
      // Applying only the realised distance step prevents residual target drift
      // once smooth zooming has settled.
      const fraction = clamp(
        1 - (this.cameraDistanceM + 2.5) / Math.max(previousDistanceM + 2.5, 2.5),
        0,
        0.42,
      );
      this.moveFocusTowardZoomAnchor(fraction);
    }

    this.updateFocusAbsolute();
    this.cameraAbsolute.copy(this.focusAbsolute).addScaledVector(this.orbitDirection, this.cameraDistanceM);
    this.cameraDirection.copy(this.cameraAbsolute).normalize();
    let actualAltitude = this.cameraAbsolute.length()
      - MARS_REFERENCE_RADIUS_M
      - this.terrainHeight(this.cameraDirection)
      - CAMERA_SURFACE_EPSILON_M;
    if (actualAltitude < 0) {
      this.cameraDistanceM = this.distanceForAltitude(0);
      this.desiredCameraDistanceM = Math.max(this.desiredCameraDistanceM, this.cameraDistanceM);
      this.cameraAbsolute.copy(this.focusAbsolute).addScaledVector(this.orbitDirection, this.cameraDistanceM);
      this.cameraDirection.copy(this.cameraAbsolute).normalize();
      actualAltitude = 0;
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
    const far = actualAltitude > 150_000
      ? actualAltitude + MARS_REFERENCE_RADIUS_M * 2.15 + MARS_ATMOSPHERE_TOP_M
      : Math.max(350_000, Math.sqrt(2 * MARS_REFERENCE_RADIUS_M * (actualAltitude + MARS_ATMOSPHERE_TOP_M)) * 3.2);
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
      altitudeM: actualAltitude < 0.02 ? 0 : actualAltitude,
      desiredAltitudeM: this.desiredAltitudeM,
      nearM: near,
      farM: far,
    };
  }

  setLocation(latitudeDeg: number, longitudeDeg: number, altitudeM = this.desiredAltitudeM) {
    const oldFocus = this.scratchA.copy(this.focusDirection);
    const direction = latLonElevationToCartesian(latitudeDeg, longitudeDeg, 0, 1);
    this.focusDirection.set(direction.x, direction.y, direction.z).normalize();
    this.scratchQuaternion.setFromUnitVectors(oldFocus, this.focusDirection);
    this.orbitDirection.applyQuaternion(this.scratchQuaternion).normalize();
    this.viewUp.applyQuaternion(this.scratchQuaternion).normalize();
    this.updateFocusAbsolute();
    this.altitudeM = this.desiredAltitudeM = clamp(altitudeM, MIN_CAMERA_ALTITUDE_M, MAX_CAMERA_ALTITUDE_M);
    this.cameraDistanceM = this.desiredCameraDistanceM = this.distanceForAltitude(this.desiredAltitudeM);
    this.zoomAnchor = null;
    this.prefetch(this.focusDirection);
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
